// SPDX-License-Identifier: Apache-2.0

// S3-C C4 — the page-level editor session (Issue #136). Called ONCE, in
// `App`, so everything here outlives the Edit tab and project switches:
//
//  - ONE `createEditorClient` adapter per page (Issue comment 2). Its
//    per-operation records are what keep an `unclaimed` lookup after an
//    ambiguous commit from being read as "definitely not committed"; they
//    are keyed by project and operation id, so the adapter is never replaced
//    on a project switch. Disposed only when the page's App really unmounts.
//  - C1's document cache, fed through a read-tagging wrapper: every read
//    gets a monotonic start sequence number, so "a read that completed after
//    it was requested" is exact (comment 3 item 2), and the controller's own
//    post-commit re-read is told apart from an external write's re-read
//    (comment 3 item 1) without relying on cache status.
//  - The controller (C2/C3), its guard inputs, the chat signals, and the
//    post-receipt coherence + display step, which finishes even with the
//    Edit tab unmounted (Tech-Lead condition 3).
//  - The preview adapter (Q1).
//
// Lazy activation (condition 4): until the Edit surface first mounts,
// `useEditorDocument` is given `projectId: null` (no read) and the controller
// is built for an inactive key with a no-op broadcast channel and no
// reconciliation work; its methods are never called. Once activated, the
// session stays active for the page's life.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { EditorDocument, EditorReceipt } from "@scadforge/protocol";
import type { ApiClient } from "../../../lib/apiClient.js";
import type { ChatItem } from "../../../lib/chatReducer.js";
import { useEditorDocument, type EditorDocumentStatus, type InvalidateReason } from "../../../hooks/useEditorDocument.js";
import { createEditorClient, type DisposableEditorClient } from "../client/editorClient.js";
import { defaultBroadcastChannelFactory } from "../controller/broadcastChannel.js";
import type { TransactionController } from "../controller/controller.js";
import type { PendingReceiptStore } from "../controller/pendingReceipts.js";
import type { SessionHistory } from "../controller/sessionLog.js";
import type {
  BroadcastChannelFactory,
  BroadcastChannelLike,
  ControllerState,
  GuardInputsSnapshot,
  PendingReconciliation,
  TimerLike,
  TransactionControllerDeps
} from "../controller/types.js";
import { useTransactionController } from "../controller/useTransactionController.js";
import { paramsKey, type PreviewStatus, type WantedRender } from "../adapter/previewAdapter.js";
import { usePreviewAdapter, type PreviewAdapterHandle, type PreviewEngineHook } from "../adapter/usePreviewAdapter.js";

/** External writes the host reports (chat signals are derived here from the items). */
export type HostWriteReason = Extract<InvalidateReason, "params-saved" | "source-saved" | "reverted" | "conflict">;

export interface EditorSessionOptions {
  api: ApiClient;
  projectId: string | null;
  sourceDirty: boolean;
  sourceConflict: boolean;
  paramsDirty: boolean;
  paramsSaving: boolean;
  chatItems: readonly ChatItem[];
  chatStreaming: boolean;
  /**
   * The head snapshot the host shows as current. After an accepted receipt the
   * pre-commit head's server mesh is not the document any more; until this
   * moves off that snapshot the local preview stays in use (L4).
   */
  headSnapshotId?: string | null;
  /** Called once per accepted receipt (App refreshes the snapshot list and re-reads the source). */
  onCommitted?: (receipt: EditorReceipt) => void;
  /** Test seams; production leaves them unset. */
  engine?: PreviewEngineHook;
  pendingReceipts?: PendingReceiptStore;
  broadcastChannelFactory?: BroadcastChannelFactory;
  timer?: TimerLike;
}

/** What `PreviewTab` shows while editing, bound to the project and revision it was rendered for. */
export interface EditPreviewBinding {
  projectId: string;
  editorRevision: string;
  status: PreviewStatus;
  /** `null` unless a render for this project/revision is ready; the viewer then shows the server render. */
  objectUrl: string | null;
  /**
   * True while the local preview is the subject: a gesture is active, a save is
   * in flight, or a post-receipt step is pending. Otherwise it is only a
   * background pre-render and the server mesh keeps the viewer (G1).
   */
  inUse: boolean;
  /** An accepted receipt's snapshot is not the host's head yet: the head's server mesh predates the document (L4). */
  headStale: boolean;
}

export interface EditorSession {
  active: boolean;
  activate(): void;
  setSurfaceMounted(mounted: boolean): void;
  api: ApiClient;
  projectId: string | null;
  document: EditorDocument | null;
  documentStatus: EditorDocumentStatus;
  documentError: unknown;
  /** The live controller for `projectId`, or `null` (not built yet, or still the previous project's). */
  controller: TransactionController | null;
  state: ControllerState;
  history: SessionHistory | null;
  editPreview: EditPreviewBinding | null;
  adapter: PreviewAdapterHandle;
  /** An external write the host saw; raises `externalWriteUnsettled` and re-reads. */
  reportWrite(reason: HostWriteReason): void;
  /** Re-read after a failed read. */
  retryRead(): void;
  /** Retry after `display-recovering`. */
  retryDisplay(): void;
}

const INACTIVE_KEY = "";

const NOOP_CHANNEL: BroadcastChannelLike = {
  postMessage() {},
  addEventListener() {},
  removeEventListener() {},
  close() {}
};

/** The real channel where the browser has one; otherwise second-tab detection is simply off. */
const safeBroadcastChannelFactory: BroadcastChannelFactory = (name) => {
  try {
    return defaultBroadcastChannelFactory(name);
  } catch {
    return NOOP_CHANNEL;
  }
};

const REAL_TIMER: TimerLike = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle)
};

function isActiveGesture(state: ControllerState): boolean {
  return state.kind === "gesture" || state.kind === "preview-pending" || state.kind === "preview-ok" || state.kind === "preview-failed";
}

/** The post-receipt coherence + display step (spec §5.3, R3). */
interface ReceiptStep {
  operationId: string;
  receipt: EditorReceipt;
  /** Only reads with a start sequence greater than this belong to the step. */
  afterSeq: number;
  /** The read the step is displaying. */
  doc: EditorDocument | null;
  /** The display failed and the controller is in `display-recovering`, waiting for Retry. */
  failed: boolean;
  /** This attempt is a Retry after a failure (ends in `notifyDisplayRecovered`). */
  recovering: boolean;
}

export function useEditorSession(options: EditorSessionOptions): EditorSession {
  const { api, projectId } = options;
  const [active, setActive] = useState(false);
  const [surfaceMounted, setSurfaceMountedState] = useState(false);

  const activate = useCallback(() => setActive(true), []);
  const setSurfaceMounted = useCallback((mounted: boolean) => setSurfaceMountedState(mounted), []);

  // Latest values for callbacks that outlive a render.
  const latest = useRef(options);
  latest.current = options;
  const activeRef = useRef(active);
  activeRef.current = active;

  // ── read tagging ───────────────────────────────────────────────────────
  const readSeqRef = useRef(0);
  const docSeqRef = useRef(new WeakMap<EditorDocument, number>());
  const errorSeqRef = useRef(new WeakMap<object, number>());
  const taggedApi = useMemo<ApiClient>(
    () => ({
      ...api,
      getEditorDocument(id: string) {
        readSeqRef.current += 1;
        const seq = readSeqRef.current;
        return api.getEditorDocument(id).then(
          (document) => {
            docSeqRef.current.set(document, seq);
            return document;
          },
          (cause: unknown) => {
            if (typeof cause === "object" && cause !== null) errorSeqRef.current.set(cause, seq);
            throw cause;
          }
        );
      }
    }),
    [api]
  );
  const seqOf = useCallback((document: EditorDocument | null) => (document ? docSeqRef.current.get(document) ?? 0 : 0), []);

  const cache = useEditorDocument(taggedApi, active ? projectId : null);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  // ── the page adapter: one per page, never per project ───────────────────
  const handlers = useRef({
    conflict: (_projectId: string) => {},
    peerCommitted: () => {},
    reconciled: (_reconciliation: PendingReconciliation) => {}
  });
  const pageClientRef = useRef<DisposableEditorClient | null>(null);
  if (!pageClientRef.current) {
    pageClientRef.current = createEditorClient({
      client: api,
      onDefiniteConflict: (conflictProjectId) => handlers.current.conflict(conflictProjectId)
    });
  }
  const pageClient = pageClientRef.current;
  const mountCountRef = useRef(0);
  useEffect(() => {
    mountCountRef.current += 1;
    return () => {
      mountCountRef.current -= 1;
      // StrictMode runs setup → cleanup → setup synchronously: dispose only if
      // no setup followed, i.e. the App really unmounted.
      queueMicrotask(() => {
        if (mountCountRef.current === 0) pageClientRef.current?.dispose();
      });
    };
  }, []);

  // ── the controller ─────────────────────────────────────────────────────
  const controllerKey = active && projectId ? projectId : INACTIVE_KEY;
  const deps = useMemo<TransactionControllerDeps>(
    () => ({
      projectId: controllerKey,
      client: pageClient,
      clock: () => Date.now(),
      timer: latest.current.timer ?? REAL_TIMER,
      // Criterion 4: real UUIDv4s on the wire.
      uuid: () => crypto.randomUUID(),
      broadcastChannelFactory:
        controllerKey === INACTIVE_KEY ? () => NOOP_CHANNEL : latest.current.broadcastChannelFactory ?? safeBroadcastChannelFactory,
      onPeerCommitted: () => handlers.current.peerCommitted(),
      ...(latest.current.pendingReceipts ? { pendingReceipts: latest.current.pendingReceipts } : {}),
      onPendingReconciled: (reconciliation) => handlers.current.reconciled(reconciliation)
    }),
    [controllerKey, pageClient]
  );
  const { state, controller: rawController } = useTransactionController(deps);

  // `useTransactionController` hands back the PREVIOUS controller for the
  // render in which `projectId` changes (its effect has not run yet). Map each
  // controller to the key of the first render it appears in, and treat a
  // mismatch as "no controller yet".
  const controllerSeenRef = useRef<{ controller: TransactionController | null; key: string }>({ controller: null, key: INACTIVE_KEY });
  if (controllerSeenRef.current.controller !== rawController) controllerSeenRef.current = { controller: rawController, key: controllerKey };
  const controller =
    rawController && controllerKey !== INACTIVE_KEY && controllerSeenRef.current.key === controllerKey ? rawController : null;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const history = useSyncExternalStore(
    useCallback((listener: () => void) => (controller ? controller.subscribe(listener) : () => {}), [controller]),
    () => (controller ? controller.history() : null)
  );

  // ── guard inputs ───────────────────────────────────────────────────────
  // `externalWriteUnsettled` is raised ONLY by external writes and cleared by
  // the first read that started after the latest raise.
  const [raisedAtSeq, setRaisedAtSeq] = useState<number | null>(null);
  const raisedAtSeqRef = useRef(raisedAtSeq);
  raisedAtSeqRef.current = raisedAtSeq;
  const [loadedFor, setLoadedFor] = useState<{ projectId: string; document: EditorDocument } | null>(null);
  const lastGood = loadedFor && loadedFor.projectId === projectId ? loadedFor.document : null;

  useEffect(() => {
    if (cache.document && cache.document.projectId === projectId) setLoadedFor({ projectId, document: cache.document });
  }, [cache.document, projectId]);

  const agentTurnRunning = options.chatStreaming || options.chatItems.some((item) => item.kind === "connection_lost");
  const guards = useMemo<GuardInputsSnapshot>(
    () => ({
      sidecarStatus: lastGood?.sidecarStatus ?? "ready",
      sourceDirty: options.sourceDirty,
      sourceConflict: options.sourceConflict,
      paramsDirty: options.paramsDirty,
      paramsSaving: options.paramsSaving,
      agentTurnRunning,
      externalWriteUnsettled: raisedAtSeq !== null || lastGood === null
    }),
    [lastGood, options.sourceDirty, options.sourceConflict, options.paramsDirty, options.paramsSaving, agentTurnRunning, raisedAtSeq]
  );
  const guardsRef = useRef(guards);
  guardsRef.current = guards;

  useEffect(() => {
    controller?.setGuardInputs(guards);
  }, [controller, guards]);

  /** An external write: raise the guard at once (no render in between), then re-read. */
  const raise = useCallback((reread: () => void) => {
    if (!activeRef.current || !latest.current.projectId) return;
    const seq = readSeqRef.current;
    setRaisedAtSeq(seq);
    raisedAtSeqRef.current = seq;
    controllerRef.current?.setGuardInputs({ ...guardsRef.current, externalWriteUnsettled: true });
    reread();
  }, []);

  useEffect(() => {
    if (raisedAtSeq === null || !cache.document) return;
    if (seqOf(cache.document) > raisedAtSeq) setRaisedAtSeq(null);
  }, [cache.document, raisedAtSeq, seqOf]);

  const reportWrite = useCallback(
    (reason: HostWriteReason) => {
      raise(() => cacheRef.current.invalidate(reason));
    },
    [raise]
  );

  // Handlers the controller and the page adapter call; never throw.
  handlers.current = {
    conflict: (conflictProjectId) => {
      if (conflictProjectId === latest.current.projectId) raise(() => cacheRef.current.invalidate("conflict"));
    },
    peerCommitted: () => raise(() => cacheRef.current.refresh()),
    reconciled: (reconciliation) => {
      // Comment 4 item 3: a reconciled operation is never this live
      // controller's own current commit (it was recorded by the controller
      // that left the project), so a committed one is an external write; a
      // not-committed one changed nothing and only needs a fresh read.
      const own = controllerRef.current?.state();
      const isOwn = own && (own.kind === "committing" || own.kind === "resolving") && own.operationId === reconciliation.operationId;
      if (reconciliation.outcome === "committed" && !isOwn) raise(() => cacheRef.current.refresh());
      else cacheRef.current.refresh();
    }
  };

  // ── chat signals (comment 1 item 3) ────────────────────────────────────
  // A terminal item is keyed `turnId:kind`. Every key not seen before in this
  // page's life raises `chat-turn-ended` once, whether or not the turn's
  // `turn_running` item was ever rendered: a fast turn's start, write and done
  // can arrive in one render. Keys present before activation are recorded
  // without raising (the first read happens on activation anyway).
  const chatSeenRef = useRef<{ lost: Set<string>; terminal: Set<string> }>({ lost: new Set(), terminal: new Set() });
  useEffect(() => {
    const lost = new Set<string>();
    const terminalTurns = new Set<string>();
    const seen = chatSeenRef.current.terminal;
    let fresh = false;
    for (const item of options.chatItems) {
      const turnId = "turnId" in item ? item.turnId : null;
      if (!turnId) continue;
      if (item.kind === "connection_lost") lost.add(turnId);
      if (item.kind === "turn_status" || item.kind === "reconciled_status" || item.kind === "error") {
        terminalTurns.add(turnId);
        const key = `${turnId}:${item.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          fresh = true;
        }
      }
    }
    const previousLost = chatSeenRef.current.lost;
    chatSeenRef.current = { lost, terminal: seen };
    if (!activeRef.current) return;
    for (const turnId of lost) {
      if (!previousLost.has(turnId)) raise(() => cacheRef.current.invalidate("chat-stream-dropped"));
    }
    for (const turnId of previousLost) {
      // Dismissed with the outcome unknown: re-read so the editor is never
      // stranded; a late agent write then surfaces as a revision conflict.
      // (Reconciled turns carry a terminal item and are handled below.)
      if (!lost.has(turnId) && !terminalTurns.has(turnId)) raise(() => cacheRef.current.refresh());
    }
    if (fresh) raise(() => cacheRef.current.invalidate("chat-turn-ended"));
  }, [options.chatItems, raise]);

  // ── post-receipt step ──────────────────────────────────────────────────
  const [step, setStep] = useState<ReceiptStep | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  const handledOperationRef = useRef<string | null>(null);
  const lastForwardedSeqRef = useRef(0);
  // L4: the head the host showed when a receipt was accepted, while it still shows it.
  const [awaitingHead, setAwaitingHead] = useState<{ preHead: string | null; snapshotId: string } | null>(null);

  // A new controller (project switch, activation) starts clean.
  useEffect(() => {
    setStep(null);
    setAwaitingHead(null);
    handledOperationRef.current = null;
    lastForwardedSeqRef.current = 0;
  }, [controller]);

  useEffect(() => {
    if (!controller || state.kind !== "committing" || !state.receipt) return;
    if (handledOperationRef.current === state.receipt.operationId) return;
    handledOperationRef.current = state.receipt.operationId;
    setStep({ operationId: state.receipt.operationId, receipt: state.receipt, afterSeq: readSeqRef.current, doc: null, failed: false, recovering: false });
    const preHead = latest.current.headSnapshotId ?? null;
    setAwaitingHead(preHead === state.receipt.snapshotId ? null : { preHead, snapshotId: state.receipt.snapshotId });
    // Our own re-read: never raises `externalWriteUnsettled` (comment 3 item 1).
    cacheRef.current.refresh();
    latest.current.onCommitted?.(state.receipt);
  }, [controller, state]);

  // L4: the head moved off the pre-commit snapshot (to the receipt's, or past it).
  const headSnapshotId = options.headSnapshotId ?? null;
  useEffect(() => {
    if (awaitingHead && headSnapshotId !== awaitingHead.preHead) setAwaitingHead(null);
  }, [awaitingHead, headSnapshotId]);

  const failStep = useCallback((current: ReceiptStep) => {
    if (!current.recovering) controllerRef.current?.notifyDisplayFailure();
    setStep({ ...current, doc: null, failed: true });
  }, []);

  // Step: wait for a read that started after the receipt (or after Retry).
  useEffect(() => {
    if (!step || step.failed || step.doc) return;
    const document = cache.document;
    if (document && document.projectId === projectId && seqOf(document) > step.afterSeq) {
      setStep({ ...step, doc: document });
      return;
    }
    const error = cache.error;
    if (cache.status === "error" && typeof error === "object" && error !== null && (errorSeqRef.current.get(error) ?? 0) > step.afterSeq) {
      failStep(step);
    }
  }, [step, cache.document, cache.status, cache.error, projectId, seqOf, failStep]);

  // Forward every other completed read (sets the log's tip; an external
  // revision makes entries stale). Never a cached value: only a document
  // object not forwarded before.
  useEffect(() => {
    const document = cache.document;
    if (!controller || !document || document.projectId !== projectId) return;
    const seq = seqOf(document);
    if (seq <= lastForwardedSeqRef.current) return;
    const current = stepRef.current;
    if (current && !current.recovering && !current.failed) return; // the step forwards its own read after display
    lastForwardedSeqRef.current = seq;
    controller.notifyDocumentRevision(document.editorRevision);
  }, [controller, cache.document, projectId, seqOf]);


  const retryRead = useCallback(() => cacheRef.current.refresh(), []);

  // ── the preview adapter ────────────────────────────────────────────────
  const document = cache.document && cache.document.projectId === projectId ? cache.document : null;
  const lastWantRef = useRef<WantedRender | null>(null);
  const want = useMemo<WantedRender | null>(() => {
    if (!controller || !projectId) return null;
    if (state.kind === "preview-pending" || state.kind === "preview-ok" || state.kind === "preview-failed") {
      const base = lastGood && lastGood.editorRevision === state.begin.baseEditorRevision ? lastGood : null;
      const feature = base?.sidecar.features.find((f) => f.featureId === state.begin.featureId);
      if (!base || !feature) return null;
      return {
        scad: base.scad,
        params: { ...base.values, [feature.binding.parameter]: state.candidate.value },
        tag: { projectId, editorRevision: base.editorRevision },
        sample: state.kind === "preview-pending" ? { generation: state.portGeneration, value: state.candidate.value } : null
      };
    }
    if (step?.doc) {
      return { scad: step.doc.scad, params: step.doc.values, tag: { projectId, editorRevision: step.doc.editorRevision }, sample: null };
    }
    if (state.kind === "committing" || state.kind === "resolving") return lastWantRef.current;
    if (document) return { scad: document.scad, params: document.values, tag: { projectId, editorRevision: document.editorRevision }, sample: null };
    return null;
  }, [controller, projectId, state, step, document, lastGood]);
  lastWantRef.current = want;

  const engineEnabled = active && (surfaceMounted || step !== null || awaitingHead !== null || isActiveGesture(state));
  const adapter = usePreviewAdapter({
    controller,
    state,
    want,
    enabled: engineEnabled,
    ...(options.engine ? { engine: options.engine } : {})
  });

  const adapterRetryRef = useRef(adapter.retry);
  adapterRetryRef.current = adapter.retry;
  const retryDisplay = useCallback(() => {
    const current = stepRef.current;
    if (!current || !current.failed) return;
    setStep({ ...current, failed: false, recovering: true, doc: null, afterSeq: readSeqRef.current });
    cacheRef.current.refresh();
    // A failed render of identical inputs is not retried by the engine on its own.
    adapterRetryRef.current();
  }, []);

  // Step: the read is displayed (or failed to display).
  const view = adapter.view;
  useEffect(() => {
    if (!step || step.failed || !step.doc || !controller) return;
    const doc = step.doc;
    if (view.tag?.editorRevision !== doc.editorRevision || view.paramsKey !== paramsKey(doc.values)) return;
    if (view.status === "pending") return;
    if (view.status === "failed") {
      failStep(step);
      return;
    }
    lastForwardedSeqRef.current = Math.max(lastForwardedSeqRef.current, seqOf(doc));
    if (step.recovering) {
      controller.notifyDisplayRecovered();
    } else {
      controller.notifyDocumentRevision(doc.editorRevision);
      // A read equal to the receipt's base (another tab restored the old
      // value) is ignored by the controller; leave the exact-revision wait
      // through the display-failure path instead of waiting forever.
      const after = controller.state();
      if (after.kind === "committing" && after.receipt?.operationId === step.operationId) {
        controller.notifyDisplayFailure();
        setStep({ ...step, doc: null, failed: true });
        return;
      }
    }
    setStep(null);
  }, [step, view, controller, seqOf, failStep]);

  const editPreview = useMemo<EditPreviewBinding | null>(() => {
    if (!engineEnabled || !projectId || !view.tag || view.tag.projectId !== projectId) return null;
    const shown = view.shown;
    // Only a finished render of exactly what is wanted; while pending or failed the host shows its server fallback (F4).
    const objectUrl = view.status === "ok" && shown && shown.tag.projectId === projectId && shown.paramsKey === view.paramsKey ? shown.objectUrl : null;
    const inUse = step !== null || awaitingHead !== null || isActiveGesture(state) || state.kind === "committing" || state.kind === "resolving";
    return { projectId, editorRevision: view.tag.editorRevision, status: view.status, objectUrl, inUse, headStale: awaitingHead !== null };
  }, [engineEnabled, projectId, view, step, awaitingHead, state]);

  return {
    active,
    activate,
    setSurfaceMounted,
    api,
    projectId,
    document,
    documentStatus: cache.status,
    documentError: cache.error,
    controller,
    state: controller ? state : { kind: "idle" },
    history,
    editPreview,
    adapter,
    reportWrite,
    retryRead,
    retryDisplay
  };
}
