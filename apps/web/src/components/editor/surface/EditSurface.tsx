// SPDX-License-Identifier: Apache-2.0

// S3-C C4 — the minimal Edit surface (Issue #136 criteria 2–4; owner
// decision 2026-09-15: deliberately plain, S4-A replaces it).
//
// Every write path has ONE entry point with its checks inside it, so a
// second way in (Enter, a shortcut) cannot skip them:
//  - typed save: the row's form `onSubmit` (button and Enter) → `submitValue`;
//  - undo/redo: `runTraversal(direction)` (buttons and shortcuts).
// After every await the surface re-checks that it is still mounted, that the
// controller and project are the ones it started with, and (for a save) that
// the controller still holds the same gesture; otherwise it drops the result
// and sends nothing.

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { EditorCommand, EditorDocument, EditorFeature, EditorProofResponse, EditorVerifyRequest } from "@scadforge/protocol";
import { ApiClientError, type ApiClient } from "../../../lib/apiClient.js";
import type { EditorDocumentStatus } from "../../../hooks/useEditorDocument.js";
import type { TransactionController } from "../controller/controller.js";
import type { SessionHistory } from "../controller/sessionLog.js";
import type {
  BeginInput,
  BeginRefusalReason,
  CancelReason,
  ControllerState,
  FinalizeRefusalReason,
  FinalizeResult,
  ProposeRefusalReason,
  TraversalDirection
} from "../controller/types.js";
import { DISABLED_COPY } from "./disabledCopy.js";
import { currentParameterValue, parseTypedValue, presentationUnit, toParameterValue, toPresentationValue } from "./featureValue.js";
import type { HostWriteReason } from "./useEditorSession.js";
import "./editSurface.css";

/** The slice of the page session this surface reads (`useEditorSession`'s result satisfies it). */
export interface EditSurfaceSession {
  activate(): void;
  setSurfaceMounted(mounted: boolean): void;
  api: Pick<ApiClient, "verifyEditorCommand">;
  projectId: string | null;
  document: EditorDocument | null;
  documentStatus: EditorDocumentStatus;
  controller: TransactionController | null;
  state: ControllerState;
  history: SessionHistory | null;
  adapter: { cancel(reason: CancelReason): boolean };
  reportWrite(reason: HostWriteReason): void;
  retryRead(): void;
  retryDisplay(): void;
}

type Notice = { tone: "info" | "success" | "error"; text: string };
type Busy = null | "save" | "undo" | "redo";

const BEGIN_COPY: Record<Exclude<BeginRefusalReason, keyof typeof DISABLED_COPY>, string> = {
  "not-idle": "Another edit is still in progress. Finish or cancel it first.",
  "proof-required": "This feature needs a fresh check before it can be edited. Try again.",
  "feature-unsupported": "This feature cannot be edited here."
};

const PROPOSE_COPY: Record<ProposeRefusalReason, string> = {
  "not-in-gesture": "The edit was cancelled. Start again.",
  "non-finite-candidate": "Enter a finite number.",
  "finalize-pending": "A save is already waiting for this preview. Cancel it to change the value."
};

const REFUSAL_COPY: Record<FinalizeRefusalReason, string> = {
  "finalize-pending": "A save is already waiting for the preview.",
  "unknown-traversal-target": "Nothing was sent: that step is no longer in this session's history.",
  "traversal-of-traversal": "Nothing was sent: an undo or redo cannot itself be undone.",
  "stale-log": "Nothing was sent: the project changed, so that step can no longer be undone or redone.",
  "target-changed": "Nothing was sent: the project changed while the step was being checked.",
  "not-idle": "Nothing was sent: another edit is in progress.",
  disabled: "Nothing was sent: editing is off right now."
};

function beginCopy(reason: BeginRefusalReason): string {
  return reason in DISABLED_COPY ? DISABLED_COPY[reason as keyof typeof DISABLED_COPY] : BEGIN_COPY[reason as keyof typeof BEGIN_COPY];
}

/** Exhaustive over all seven `FinalizeResult` kinds; only `committed` reads as saved. */
export function describeResult(result: FinalizeResult, action: "save" | "undo" | "redo"): Notice {
  const label = action === "save" ? "Change" : action === "undo" ? "Undo" : "Redo";
  switch (result.kind) {
    case "committed":
      return { tone: "success", text: action === "save" ? "Saved." : `${label} saved.` };
    case "rejected":
      return { tone: "error", text: `${label} was not saved${result.error ? `: ${result.error.message}` : ` (${result.reason}).`}` };
    case "detached":
      return { tone: "info", text: "You left the project before the save was confirmed. It is checked again when you return." };
    case "preview-failed":
      return { tone: "error", text: "The preview failed, so nothing was saved. Cancel, then try again." };
    case "cancelled":
      return { tone: "info", text: "Cancelled. Nothing was saved." };
    case "refused":
      return { tone: "info", text: REFUSAL_COPY[result.reason] };
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

function isActiveGesture(state: ControllerState): state is Extract<ControllerState, { kind: "gesture" | "preview-pending" | "preview-ok" | "preview-failed" }> {
  return state.kind === "gesture" || state.kind === "preview-pending" || state.kind === "preview-ok" || state.kind === "preview-failed";
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function statusLine(session: EditSurfaceSession, ready: boolean, notice: Notice | null): string {
  const { state, documentStatus, document } = session;
  if (!session.controller) return "Preparing the editor…";
  if (documentStatus === "error") return "The editor could not load this project's features.";
  if (!document) return "Loading features…";
  switch (state.kind) {
    case "disabled":
      return DISABLED_COPY[state.reason];
    case "committing":
      return state.receipt ? "Saved. Updating the preview…" : "Saving…";
    case "resolving":
      return "Resolving: checking whether your change was saved…";
    case "gesture":
    case "preview-pending":
      return "Rendering the preview…";
    case "preview-ok":
      return "Preview ready. Save to keep it, or Cancel.";
    case "preview-failed":
      return "The preview failed. Cancel to try again.";
    case "cancelling":
      return "Cancelling…";
    case "idle":
      if (!ready) return "Loading the latest version…";
      return notice?.text ?? "Ready.";
  }
}

export function EditSurface({ session }: { session: EditSurfaceSession }) {
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const mountedRef = useRef(false);
  const [busy, setBusyState] = useState<Busy>(null);
  const busyRef = useRef<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  function setBusy(next: Busy): void {
    busyRef.current = next;
    if (mountedRef.current) setBusyState(next);
  }

  function show(next: Notice): void {
    if (mountedRef.current) setNotice(next);
  }

  // Mount: activate the page session; unmount: the gesture owner is gone, so
  // an active gesture is cancelled (a commit in flight is left to the
  // session, which finishes it with this tab closed).
  useEffect(() => {
    mountedRef.current = true;
    const current = sessionRef.current;
    current.activate();
    current.setSurfaceMounted(true);
    return () => {
      mountedRef.current = false;
      sessionRef.current.setSurfaceMounted(false);
      sessionRef.current.adapter.cancel("unmount");
    };
  }, []);

  function stillCurrent(controller: TransactionController, projectId: string): boolean {
    const current = sessionRef.current;
    return mountedRef.current && current.controller === controller && current.projectId === projectId;
  }

  async function verify(projectId: string, request: EditorVerifyRequest): Promise<EditorProofResponse | null> {
    try {
      return await sessionRef.current.api.verifyEditorCommand(projectId, request);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.error_code === "CONFLICT") {
        sessionRef.current.reportWrite("conflict");
        show({ tone: "error", text: "The project changed since this value was loaded. It is reloading; try again once it has." });
      } else {
        show({ tone: "error", text: `The change could not be checked: ${cause instanceof Error ? cause.message : "unknown error"}.` });
      }
      return null;
    }
  }

  async function submitValue(feature: EditorFeature, text: string, mode: "preview" | "save"): Promise<void> {
    const { controller, document, projectId } = sessionRef.current;
    if (!controller || !document || !projectId || busyRef.current) return;
    if (mountedRef.current) setNotice(null);
    const paramValue = toParameterValue(feature.binding, parseTypedValue(text));

    const before = controller.state();
    let begin: BeginInput;
    // A proof already obtained for exactly this command (requires-proof features verify before `begin`).
    let proofInHand: EditorProofResponse | null = null;
    if (isActiveGesture(before)) {
      if (before.begin.featureId !== feature.featureId) {
        show({ tone: "info", text: BEGIN_COPY["not-idle"] });
        return;
      }
      begin = before.begin;
    } else {
      const baseValue = currentParameterValue(document, feature);
      if (baseValue === null) {
        show({ tone: "error", text: "This feature's parameter is not a number, so it cannot be edited here." });
        return;
      }
      const eligibility = document.eligibility.find((entry) => entry.featureId === feature.featureId) ?? null;
      if (eligibility?.state === "requires-proof") {
        if (!Number.isFinite(paramValue)) {
          show({ tone: "error", text: PROPOSE_COPY["non-finite-candidate"] });
          return;
        }
        setBusy("save");
        try {
          proofInHand = await verify(projectId, {
            version: 1,
            baseEditorRevision: document.editorRevision,
            command: { kind: "set-value", featureId: feature.featureId, bindingVersion: feature.bindingVersion, value: paramValue },
            intent: "edit",
            traversal: null
          });
        } finally {
          setBusy(null);
        }
        // Re-checked after the await: same controller and project, still idle, same document revision.
        if (
          !proofInHand ||
          !stillCurrent(controller, projectId) ||
          controller.state().kind !== "idle" ||
          sessionRef.current.document?.editorRevision !== document.editorRevision
        ) {
          return;
        }
      }
      // Frozen snapshot of what the edit is based on; nothing below reads the live document again.
      begin = Object.freeze({
        featureId: feature.featureId,
        bindingVersion: feature.bindingVersion,
        baseEditorRevision: document.editorRevision,
        sourceFingerprint: document.sourceFingerprint,
        sidecarStatus: document.sidecarStatus,
        eligibility,
        freshProof: proofInHand,
        baseValue
      });
      const began = controller.begin(begin);
      if (!began.ok) {
        show({ tone: "info", text: beginCopy(began.reason) });
        return;
      }
    }

    const current = controller.state();
    const alreadyCandidate = (current.kind === "preview-pending" || current.kind === "preview-ok") && current.candidate.value === paramValue;
    if (!alreadyCandidate) {
      const proposed = controller.propose(paramValue, "typed");
      if (!proposed.ok) {
        show({ tone: "error", text: PROPOSE_COPY[proposed.reason] });
        return;
      }
      if ("noOp" in proposed) {
        show({ tone: "info", text: "That is already the current value. Nothing was saved." });
        return;
      }
    }
    if (mode === "preview") return;

    const command: EditorCommand = { kind: "set-value", featureId: begin.featureId, bindingVersion: begin.bindingVersion, value: paramValue };
    setBusy("save");
    try {
      const proof =
        proofInHand ?? (await verify(projectId, { version: 1, baseEditorRevision: begin.baseEditorRevision, command, intent: "edit", traversal: null }));
      if (!proof || !stillCurrent(controller, projectId)) return;
      const now = controller.state();
      const sameGesture =
        (now.kind === "preview-pending" || now.kind === "preview-ok") && now.begin === begin && now.candidate.value === paramValue;
      if (!sameGesture) return;
      const result = await controller.submitVerified(command, proof, "edit", null, { beforeValue: begin.baseValue });
      show(describeResult(result, "save"));
    } finally {
      setBusy(null);
    }
  }

  async function runTraversal(direction: TraversalDirection): Promise<void> {
    const { controller, projectId } = sessionRef.current;
    if (!controller || !projectId || busyRef.current) return;
    const history = controller.history();
    if (direction === "undo" ? !history.canUndo : !history.canRedo) return;
    const prepared = controller.prepareTraversal(direction);
    if (!prepared.ok) return; // nothing to do right now; not an error
    if (mountedRef.current) setNotice(null);
    setBusy(direction);
    try {
      const proof = await verify(projectId, prepared.request);
      if (!proof || !stillCurrent(controller, projectId)) return;
      const result = await controller.submitTraversal({ request: prepared.request }, proof);
      show(describeResult(result, direction));
    } finally {
      setBusy(null);
    }
  }

  const runTraversalRef = useRef(runTraversal);
  runTraversalRef.current = runTraversal;

  // Shortcuts route to the same function as the buttons. Ignored inside
  // editable fields so native text undo keeps working there.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        void runTraversalRef.current(event.shiftKey ? "redo" : "undo");
      } else if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        void runTraversalRef.current("redo");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { controller, state, document, documentStatus, history } = session;
  // `loading` and `unsettled` are both "not ready" (Issue comment 1 item 1).
  const ready = documentStatus === "ready" && document !== null;
  const idle = state.kind === "idle";
  const canUndo = Boolean(controller && ready && idle && !busy && history?.canUndo);
  const canRedo = Boolean(controller && ready && idle && !busy && history?.canRedo);
  const gestureFeatureId = isActiveGesture(state) ? state.begin.featureId : null;
  const stateLine = statusLine(session, ready, notice);
  // A problem reported mid-gesture (a failed check) is added to the gesture's own line.
  const line = !idle && notice?.tone === "error" ? `${stateLine} ${notice.text}` : stateLine;
  const tone = state.kind === "disabled" || state.kind === "preview-failed" || documentStatus === "error" ? "error" : idle && notice ? notice.tone : "info";

  return (
    <section className="edit-surface" aria-labelledby="edit-surface-title" data-testid="edit-surface">
      <div className="edit-surface-header">
        <h2 id="edit-surface-title">Edit features</h2>
        <div className="edit-surface-history" role="group" aria-label="Undo and redo">
          <button type="button" className="button button--secondary" onClick={() => void runTraversal("undo")} disabled={!canUndo} aria-keyshortcuts="Control+Z Meta+Z">
            Undo
          </button>
          <button type="button" className="button button--secondary" onClick={() => void runTraversal("redo")} disabled={!canRedo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y">
            Redo
          </button>
        </div>
      </div>

      <p className={`edit-surface-status edit-surface-status--${tone}`} role="status" aria-live="polite" data-testid="edit-status">
        {line}
      </p>
      {controller && state.kind === "disabled" && state.reason === "display-recovering" ? (
        <button type="button" className="button button--primary edit-surface-retry" onClick={() => session.retryDisplay()}>
          Retry preview
        </button>
      ) : null}
      {controller && documentStatus === "error" ? (
        <button type="button" className="button button--secondary edit-surface-retry" onClick={() => session.retryRead()}>
          Retry loading
        </button>
      ) : null}

      {controller && document ? (
        document.sidecar.features.length === 0 ? (
          <p className="edit-surface-empty">This project has no editable features yet.</p>
        ) : (
          <ul className="edit-feature-list" aria-label="Editable features">
            {document.sidecar.features.map((feature) => {
              const eligibility = document.eligibility.find((entry) => entry.featureId === feature.featureId) ?? null;
              const unsupported = eligibility?.state === "unsupported";
              const inGesture = gestureFeatureId === feature.featureId;
              const enabled = ready && !busy && !unsupported && (idle || (inGesture && state.kind !== "preview-failed"));
              return (
                <FeatureRow
                  key={feature.featureId}
                  feature={feature}
                  document={document}
                  eligibilityText={
                    eligibility
                      ? eligibility.state === "unsupported"
                        ? `Cannot be edited here${eligibility.reason ? `: ${eligibility.reason}` : "."}`
                        : `Needs a fresh check before saving${eligibility.reason ? `: ${eligibility.reason}` : "."}`
                      : null
                  }
                  enabled={enabled}
                  inGesture={inGesture}
                  onPreview={(text) => void submitValue(feature, text, "preview")}
                  onSave={(text) => void submitValue(feature, text, "save")}
                  onCancel={() => session.adapter.cancel("escape")}
                />
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}

interface FeatureRowProps {
  feature: EditorFeature;
  document: EditorDocument;
  eligibilityText: string | null;
  enabled: boolean;
  inGesture: boolean;
  onPreview(text: string): void;
  onSave(text: string): void;
  onCancel(): void;
}

function FeatureRow({ feature, document, eligibilityText, enabled, inGesture, onPreview, onSave, onCancel }: FeatureRowProps) {
  const parameterValue = currentParameterValue(document, feature);
  const shown = parameterValue === null ? null : toPresentationValue(feature.binding, parameterValue);
  const [text, setText] = useState(shown === null ? "" : String(shown));
  const inputId = `edit-feature-${feature.featureId}`;
  const hintId = `${inputId}-hint`;
  const unit = presentationUnit(feature.binding);

  // A new authoritative value replaces the field's text unless the user is mid-edit on this row.
  useEffect(() => {
    if (!inGesture) setText(shown === null ? "" : String(shown));
  }, [document.editorRevision, shown, inGesture]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(text);
  }

  return (
    <li className="edit-feature">
      <form className="edit-feature-form" onSubmit={handleSubmit} aria-label={`Edit ${feature.label || feature.featureId}`}>
        <label className="edit-feature-label" htmlFor={inputId}>
          {feature.label || feature.featureId}
          <span className="edit-feature-meta">
            {feature.binding.parameter}
            {unit ? ` · ${unit}` : ""} · mm
          </span>
        </label>
        <div className="edit-feature-controls">
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={!enabled}
            aria-describedby={hintId}
          />
          <button type="button" className="button button--secondary" onClick={() => onPreview(text)} disabled={!enabled}>
            Preview
          </button>
          <button type="submit" className="button button--primary" disabled={!enabled}>
            Save
          </button>
          {inGesture ? (
            <button type="button" className="button button--ghost" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
        <p className="edit-feature-hint" id={hintId}>
          Current: {shown === null ? "not a number" : `${shown} mm`}
          {eligibilityText ? ` · ${eligibilityText}` : ""}
        </p>
      </form>
    </li>
  );
}
