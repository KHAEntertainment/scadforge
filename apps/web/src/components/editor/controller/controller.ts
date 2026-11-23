// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — the transaction controller core (Issue #113).
//
// A pure, framework-free state machine that turns one user-visible parameter
// edit into exactly zero or one committed editor command, and never strands.
// Every transition off the preview lifecycle is driven by PORT STATE
// (`port.ts`), never by WASM status events — that is what fixes the drei
// trial's two preserved defects:
//   Failure A — a release while the preview is pending used to strand the
//   transaction in `preview-failed` with no way back to `idle`.
//   Failure B — a successful typed preview used to never finalize, because
//   the render-callback fired on stale port state.
//
// Governing spec: epics/.../s3-s4-plan/s3-contract/s3-c-transaction-controller
// §3 (states/transitions/guards/cancel/no-op) and §4.1 (API surface, DRAFT —
// this implementation departs from the DRAFT `finalize()`/`FinalizeResult`
// shape where the injected-dependency reality requires it; see the PR
// description for the specific, Tech-Lead-approved departures). Operation
// IDs follow the ticket story's ruling (minted at `finalize`, reused for
// polls, fresh only after a definite answer) as further specified by the
// Tech-Lead's R1–R4 rulings on Issue #113.

import type { EditorCommitRequest, EditorProofResponse, EditorReceipt } from "@scadforge/protocol";
import { resolvingBackoffDelayMs } from "./backoff.js";
import { SecondTabDetector } from "./broadcastChannel.js";
import { sharedPendingReceipts, type PendingReceiptRecord } from "./pendingReceipts.js";
import { TransactionPort, type TransactionPortWriter } from "./port.js";
import { SessionLog, type EntryDraft, type SessionHistory } from "./sessionLog.js";
import { canonicalJson, cloneFrozen, deriveTraversalCommand } from "./traversalCommand.js";
import type {
  BeginInput,
  BeginResult,
  Candidate,
  CancelReason,
  CommitOutcome,
  ControllerState,
  DisabledReason,
  EditorCommand,
  EditorIntent,
  EditorTraversal,
  FinalizeRefusalReason,
  FinalizeResult,
  GuardInputsSnapshot,
  PendingReconciliation,
  PrepareTraversalResult,
  PreparedTraversal,
  ProposeResult,
  SubmitContext,
  TransactionControllerDeps,
  TraversalDirection
} from "./types.js";

type ActiveGestureState = Extract<
  ControllerState,
  { kind: "gesture" | "preview-pending" | "preview-ok" | "preview-failed" }
>;

function isActiveGesture(state: ControllerState): state is ActiveGestureState {
  return (
    state.kind === "gesture" ||
    state.kind === "preview-pending" ||
    state.kind === "preview-ok" ||
    state.kind === "preview-failed"
  );
}

/** Bookkeeping for a `finalize`/`submitVerified` call made while still `preview-pending`. */
interface PendingCommitWait {
  resolve: (result: FinalizeResult) => void;
  /** Invoked once the port resolves to a matching sample (state is now `preview-ok`). */
  proceed: () => void;
}

/** Bookkeeping for one in-flight commit attempt, from the first POST through any resolving polls. */
interface ActiveCommit {
  operationId: string;
  resolveFinalize: (result: FinalizeResult) => void;
  aborted: boolean;
  /** Snapshots taken when the commit was sent — the log is built from these, never from caller-owned objects. */
  intent: EditorIntent;
  traversal: EditorTraversal | null;
  draft: EntryDraft | null;
}

/** Snapshot of the caller-supplied inputs of a `finalize`/`submitVerified` call, taken before any wait. */
interface CommitInputs {
  command: EditorCommand;
  proof: EditorProofResponse;
  intent: EditorIntent;
  traversal: EditorTraversal | null;
  context: SubmitContext | null;
}

export class TransactionController {
  private readonly port = new TransactionPort();
  private readonly secondTabDetector: SecondTabDetector;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribePort: () => void;

  private current: ControllerState = { kind: "idle" };
  private disposed = false;
  private guardInputs: GuardInputsSnapshot | null = null;
  private displayRecovering = false;
  private portGenerationCounter = 0;

  private pendingCommit: PendingCommitWait | null = null;
  private activeCommit: ActiveCommit | null = null;
  private resolvingTimerHandle: number | null = null;

  private readonly log = new SessionLog();
  private readonly pendingReceipts: NonNullable<TransactionControllerDeps["pendingReceipts"]>;
  /** Pending reconciliation backoff waits: timer handle -> the resolver of the promise awaiting it. */
  private readonly reconcileWaits = new Map<number, () => void>();
  private reconcileRun: Promise<void> | null = null;

  constructor(private readonly deps: TransactionControllerDeps) {
    this.pendingReceipts = deps.pendingReceipts ?? sharedPendingReceipts;
    this.secondTabDetector = new SecondTabDetector(
      deps.broadcastChannelFactory,
      deps.projectId,
      deps.onPeerCommitted
    );
    this.unsubscribePort = this.port.subscribe(() => this.handlePortChange());
    // Returning to a project: look up anything recorded when we last left it.
    void this.reconcilePending();
  }

  // ── observation ────────────────────────────────────────────────────────

  state(): ControllerState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The session log read surface (spec §5): immutable, with a stable
   * reference until something changes, so a host can bind it to
   * `useSyncExternalStore` through `subscribe`.
   */
  history(): SessionHistory {
    return this.log.history();
  }

  /** The writer half C4's preview adapter writes samples to. */
  get portWriter(): TransactionPortWriter {
    return this.port;
  }

  // ── guard inputs / disabled (spec §10.2 Q3, amended) ─────────────────────

  setGuardInputs(inputs: GuardInputsSnapshot): void {
    if (this.disposed) return;
    const wasUnsettled = this.guardInputs?.externalWriteUnsettled ?? false;
    this.guardInputs = inputs;
    // C1's `invalidate()` (an external write): entries become stale and redo
    // is cleared at once, whatever the transaction is doing — the server's
    // own revision check still governs an in-flight commit.
    if (inputs.externalWriteUnsettled && !wasUnsettled && this.log.invalidate()) this.emit();
    // R4: an external write invalidates an active direct edit mid-gesture —
    // zero network, no log entry, no seventh CancelReason. In committing/
    // resolving the server's own revision check governs instead (a stale
    // commit comes back as a definite CONFLICT), so leave those alone.
    if (inputs.externalWriteUnsettled && isActiveGesture(this.current)) {
      this.abortForExternalWrite();
    }
    this.recomputeIdleDisabled();
  }

  notifyDisplayFailure(): void {
    if (this.disposed) return;
    // Only meaningful once a receipt is known and we are still awaiting
    // document coherence (R3); otherwise there is nothing to recover from.
    if (this.current.kind !== "committing" || !this.current.receipt) return;
    this.displayRecovering = true;
    // Spec §5.3: the cursor already moved from the receipt; redo is cleared
    // for the next gesture and recovery does not resurrect it.
    this.log.clearRedo();
    this.setState({ kind: "idle" });
    this.recomputeIdleDisabled();
  }

  notifyDisplayRecovered(): void {
    if (this.disposed || !this.displayRecovering) return;
    this.displayRecovering = false;
    this.recomputeIdleDisabled();
  }

  /**
   * The host's document cache reports a completed read at `editorRevision`
   * (R3), and optionally that read's sidecar digest. Two jobs:
   *
   * - While `committing` with a receipt, any read AFTER the receipt makes it
   *   safe to go `idle` — going idle on the receipt alone would let the next
   *   `begin` capture a stale `baseEditorRevision`. The read normally equals
   *   the receipt's revision; if another tab wrote in between it is a
   *   different one, and nothing waits for the document to equal the
   *   receipt (spec criterion 5). Only a read equal to the receipt's
   *   `baseEditorRevision` is ignored: that is a read that started before the
   *   commit landed.
   * - A revision that differs from the last receipt applied to the log is an
   *   external write: entries go stale and redo is cleared. Reads delivered
   *   while a commit is still in flight are ignored, since one may already
   *   show that commit's own result.
   */
  notifyDocumentRevision(editorRevision: string, sidecarDigest?: string): void {
    if (this.disposed) return;
    const current = this.current;
    if (current.kind === "committing" || current.kind === "resolving") {
      const receipt = current.kind === "committing" ? current.receipt : null;
      if (!receipt) return;
      if (editorRevision === receipt.baseEditorRevision && editorRevision !== receipt.editorRevision) return;
      this.log.reconcileRevision(editorRevision, sidecarDigest);
      this.setState({ kind: "idle" });
      this.recomputeIdleDisabled();
      return;
    }
    if (this.log.reconcileRevision(editorRevision, sidecarDigest)) this.emit();
  }

  private computeDisabledReason(): DisabledReason | null {
    if (this.displayRecovering) return "display-recovering";
    const g = this.guardInputs;
    if (!g) return null;
    if (g.sidecarStatus === "corrupt" || g.sidecarStatus === "missing" || g.sidecarStatus === "unsupported-version") {
      return "sidecar-unreadable";
    }
    if (g.sourceDirty || g.sourceConflict) return "source-dirty";
    if (g.paramsDirty || g.paramsSaving) return "params-pending";
    if (g.agentTurnRunning) return "agent-turn-running";
    if (g.externalWriteUnsettled) return "external-write-unsettled";
    return null;
  }

  private recomputeIdleDisabled(): void {
    if (this.current.kind !== "idle" && this.current.kind !== "disabled") return;
    const reason = this.computeDisabledReason();
    if (reason) {
      // Semantically unchanged — no fresh object, no notify.
      if (this.current.kind === "disabled" && this.current.reason === reason) return;
      this.setState({ kind: "disabled", reason });
    } else {
      if (this.current.kind === "idle") return;
      this.setState({ kind: "idle" });
    }
  }

  // ── begin / propose / cancel (spec §3.1–§3.5) ────────────────────────────

  begin(input: BeginInput): BeginResult {
    if (this.disposed) return { ok: false, reason: "not-idle" };
    if (this.current.kind === "disabled") return { ok: false, reason: this.current.reason };
    if (this.current.kind !== "idle") return { ok: false, reason: "not-idle" };

    const eligibility = input.eligibility;
    if (eligibility?.state === "unsupported") return { ok: false, reason: "feature-unsupported" };
    if (eligibility?.state === "requires-proof") {
      const proof = input.freshProof;
      // An `expiresAt` that fails to parse (NaN) must count as EXPIRED, not
      // valid — `clock() >= NaN` is always false, which would otherwise let
      // an unparseable proof through as though it never expires.
      const expiresAtMs = proof ? Date.parse(proof.expiresAt) : NaN;
      if (!proof || !Number.isFinite(expiresAtMs) || this.deps.clock() >= expiresAtMs) {
        return { ok: false, reason: "proof-required" };
      }
    }

    this.port.reset(this.freshPortGeneration());
    this.setState({ kind: "gesture", begin: input });
    return { ok: true };
  }

  propose(candidate: number, source: Candidate["source"]): ProposeResult {
    if (this.disposed) return { ok: false, reason: "not-in-gesture" };
    if (this.current.kind !== "gesture" && this.current.kind !== "preview-pending" && this.current.kind !== "preview-ok") {
      return { ok: false, reason: "not-in-gesture" };
    }
    // A non-finite candidate would also defeat the no-op guard below
    // (`NaN === base` is always false), letting NaN/±Infinity reach
    // preview-pending and eventually verify/commit.
    if (!Number.isFinite(candidate)) return { ok: false, reason: "non-finite-candidate" };
    // A finalize/submitVerified call already captured a candidate value and
    // is waiting on the port for it; changing the candidate underneath that
    // wait could let a later confirmation commit a stale value.
    if (this.pendingCommit) return { ok: false, reason: "finalize-pending" };
    const begin = this.current.begin;

    // No-op short-circuit (§3.5): zero port writes beyond realignment, zero
    // log entries, zero network requests, before any request is built.
    if (candidate === begin.baseValue) {
      this.port.reset(this.freshPortGeneration());
      this.setState({ kind: "idle" });
      this.recomputeIdleDisabled();
      return { ok: true, noOp: true };
    }

    const portGeneration = this.freshPortGeneration();
    this.port.reset(portGeneration);
    this.setState({ kind: "preview-pending", begin, candidate: { value: candidate, source }, portGeneration });
    return { ok: true, state: this.current };
  }

  /** Force a re-read of the latest port sample (spec §4.1) — a manual nudge for a missed push. */
  refreshPort(): void {
    this.handlePortChange();
  }

  cancel(reason: CancelReason): void {
    if (this.disposed) return;
    switch (this.current.kind) {
      case "gesture":
      case "preview-pending":
      case "preview-ok":
      case "preview-failed":
        this.abortViaCancel(reason);
        return;
      case "committing":
      case "resolving":
        // R2: past the point of no return — the five other reasons are a
        // no-op; only "unmount" detaches (it never abandons silently).
        if (reason === "unmount") this.detach();
        return;
      default:
        return; // idle, disabled, cancelling: nothing to cancel
    }
  }

  /**
   * The six `cancel` reasons (spec §3.4): every one converges on
   * `cancelling → idle`, both transitions observable to subscribers, with
   * zero network request and zero log entry.
   */
  private abortViaCancel(reason: CancelReason): void {
    const pending = this.pendingCommit;
    this.pendingCommit = null;
    this.port.reset(this.freshPortGeneration());
    this.setState({ kind: "cancelling", reason });
    this.setState({ kind: "idle" });
    pending?.resolve({ kind: "cancelled" });
  }

  /**
   * R4's external-write invalidation: NOT a seventh `CancelReason` and NOT
   * routed through `cancelling` — the spec's cancel-reason convergence is
   * for the six typed reasons only. Same zero-network/zero-log guarantee.
   */
  private abortForExternalWrite(): void {
    const pending = this.pendingCommit;
    this.pendingCommit = null;
    this.port.reset(this.freshPortGeneration());
    this.setState({ kind: "idle" });
    pending?.resolve({ kind: "cancelled" });
  }

  // ── the port drives preview-pending → preview-ok/preview-failed ─────────

  private handlePortChange(): void {
    if (this.current.kind !== "preview-pending") return;
    const read = this.port.read();
    if (read.status === "sample" && read.value === this.current.candidate.value) {
      this.setState({
        kind: "preview-ok",
        begin: this.current.begin,
        candidate: this.current.candidate,
        portGeneration: read.generation
      });
      const pending = this.pendingCommit;
      if (pending) {
        this.pendingCommit = null;
        pending.proceed();
      }
      return;
    }
    if (read.status === "failed") {
      this.setState({ kind: "preview-failed", begin: this.current.begin, candidate: this.current.candidate });
      const pending = this.pendingCommit;
      if (pending) {
        this.pendingCommit = null;
        pending.resolve({ kind: "preview-failed" });
      }
    }
  }

  private freshPortGeneration(): number {
    this.portGenerationCounter += 1;
    return this.portGenerationCounter;
  }

  // ── commit (spec §4.1, §5–§6.3; Tech-Lead rulings R1–R3) ─────────────────

  /**
   * The drag/typed path: commits the current gesture's candidate as a
   * `set-value` command. Waits on the port if still `preview-pending`
   * (fixes Failure A/B — driven by port state, not status events).
   *
   * A second call while the first is still waiting on the port is refused
   * (`{ kind: "refused", reason: "finalize-pending" }`); the first wait is
   * untouched and still settles through the port, `cancel`, `detach` or
   * `dispose`.
   */
  async finalize(proof: EditorProofResponse): Promise<FinalizeResult> {
    if (this.pendingCommit) return { kind: "refused", reason: "finalize-pending" };
    if (this.current.kind === "preview-ok") {
      const begin = this.current.begin;
      return this.sendCommit(
        this.snapshotInputs(this.buildSetValueCommand(begin, this.current.candidate.value), proof, "edit", null, { beforeValue: begin.baseValue })
      );
    }
    if (this.current.kind === "preview-pending") {
      const begin = this.current.begin;
      const candidateValue = this.current.candidate.value;
      // Taken now, before the wait: the caller may mutate or reuse `proof`.
      const inputs = this.snapshotInputs(this.buildSetValueCommand(begin, candidateValue), proof, "edit", null, { beforeValue: begin.baseValue });
      return new Promise<FinalizeResult>((resolve) => {
        this.pendingCommit = {
          resolve,
          proceed: () => {
            // Guard (spec §3.3): "candidate equals the latest port value".
            // `propose` now refuses while a pendingCommit exists, so this
            // should be unreachable in practice — kept as a defensive
            // invariant check rather than committing a stale value.
            if (this.current.kind !== "preview-ok" || this.current.candidate.value !== candidateValue) {
              resolve({ kind: "cancelled" });
              return;
            }
            this.sendCommit(inputs).then(resolve);
          }
        };
      });
    }
    throw new Error(`finalize() called from unexpected state "${this.current.kind}"`);
  }

  /**
   * The direct-command path: `intent`/`traversal` default to a plain edit
   * (typed entry's usual call). Undo/redo go through `prepareTraversal` +
   * `submitTraversal`; S4-A passes `intent: "setup"` for `put-feature`/
   * `remove-feature`, with `context.beforeFeature` so the log can rebuild the
   * exact inverse later. Usable from `idle` (undo/redo/setup have no drag
   * gesture) or from an active gesture, waiting on the port the same way
   * `finalize` does.
   *
   * An `undo`/`redo` intent is validated locally against the log first: it
   * must name the entry at the cursor, in that direction, and never an
   * accepted undo/redo (Q5). Anything else is refused with no request sent.
   */
  async submitVerified(
    command: EditorCommand,
    proof: EditorProofResponse,
    intent: EditorIntent = "edit",
    traversal: EditorTraversal | null = null,
    context: SubmitContext | null = null
  ): Promise<FinalizeResult> {
    if (this.pendingCommit) return { kind: "refused", reason: "finalize-pending" };
    const inputs = this.snapshotInputs(command, proof, intent, traversal, context);
    if (inputs.intent === "undo" || inputs.intent === "redo") return this.submitTraversalCommand(inputs);
    // `traversal` is mandatory for undo/redo and must be null for edit/setup (protocol).
    if (inputs.traversal) return { kind: "refused", reason: "unknown-traversal-target" };
    if (this.current.kind === "idle" || this.current.kind === "preview-ok") {
      return this.sendCommit(inputs);
    }
    if (this.current.kind === "preview-pending") {
      return new Promise<FinalizeResult>((resolve) => {
        this.pendingCommit = {
          resolve,
          proceed: () => {
            // Same defensive invariant as `finalize` — unreachable in
            // practice now that `propose` refuses while a pendingCommit
            // exists, but never send on an unexpected state.
            if (this.current.kind !== "preview-ok") {
              resolve({ kind: "cancelled" });
              return;
            }
            this.sendCommit(inputs).then(resolve);
          }
        };
      });
    }
    throw new Error(`submitVerified() called from unexpected state "${this.current.kind}"`);
  }

  private buildSetValueCommand(begin: BeginInput, value: number): EditorCommand {
    return { kind: "set-value", featureId: begin.featureId, bindingVersion: begin.bindingVersion, value };
  }

  /** Deep-copies everything a caller owns, so later mutation can neither change what is sent nor what is logged. */
  private snapshotInputs(
    command: EditorCommand,
    proof: EditorProofResponse,
    intent: EditorIntent,
    traversal: EditorTraversal | null,
    context: SubmitContext | null
  ): CommitInputs {
    return {
      command: cloneFrozen(command),
      proof: cloneFrozen(proof),
      intent,
      traversal: traversal ? cloneFrozen(traversal) : null,
      context: context ? cloneFrozen(context) : null
    };
  }

  // ── undo / redo (spec §5.4: server commands, never local rewinds) ────────

  /**
   * Builds the complete verify request for undoing/redoing the entry at the
   * cursor. The host passes `result.request` unchanged to
   * `verifyEditorCommand`, then hands the proof and this result back to
   * `submitTraversal`. Nothing is sent and nothing changes here.
   */
  prepareTraversal(direction: TraversalDirection): PrepareTraversalResult {
    if (this.disposed) return { ok: false, reason: "not-idle" };
    if (this.current.kind === "disabled") return { ok: false, reason: "disabled" };
    if (this.current.kind !== "idle") return { ok: false, reason: "not-idle" };
    return this.deriveTraversalRequest(direction);
  }

  /**
   * The ONE validity rule for any undo/redo, shared by `prepareTraversal`
   * (and so `submitTraversal`) and the direct `submitVerified` path so the
   * two cannot drift: the entry at the cursor must exist and be fresh (an
   * external write makes it stale), the log must know its tip revision, and
   * the exact inverse must be derivable from what was recorded.
   */
  private deriveTraversalRequest(direction: TraversalDirection): PrepareTraversalResult {
    const target = this.log.target(direction);
    if (!target) return { ok: false, reason: direction === "undo" ? "nothing-to-undo" : "nothing-to-redo" };
    const baseEditorRevision = this.log.tip;
    if (target.stale || baseEditorRevision === null) return { ok: false, reason: "stale-log" };
    const command = deriveTraversalCommand(target.entry, direction);
    if (!command) return { ok: false, reason: "not-traversable" };
    return {
      ok: true,
      request: cloneFrozen({
        version: 1 as const,
        baseEditorRevision,
        command,
        intent: direction,
        traversal: { operationId: target.entry.operationId, direction }
      })
    };
  }

  /**
   * Commits a previously prepared traversal with the host's proof. The host
   * awaited between `prepareTraversal` and here, so the request is derived
   * again now and refused (`target-changed`, nothing sent) unless it equals
   * the verified one by value.
   */
  async submitTraversal(prepared: PreparedTraversal, proof: EditorProofResponse): Promise<FinalizeResult> {
    if (this.pendingCommit) return { kind: "refused", reason: "finalize-pending" };
    const verified = prepared.request;
    if (verified.intent !== "undo" && verified.intent !== "redo") return { kind: "refused", reason: "unknown-traversal-target" };
    const again = this.prepareTraversal(verified.intent);
    if (!again.ok) {
      if (again.reason === "not-idle" || again.reason === "disabled") return { kind: "refused", reason: again.reason };
      return { kind: "refused", reason: "target-changed" };
    }
    if (canonicalJson(again.request) !== canonicalJson(verified) || proof.baseEditorRevision !== again.request.baseEditorRevision) {
      return { kind: "refused", reason: "target-changed" };
    }
    return this.sendCommit(this.snapshotInputs(again.request.command, proof, again.request.intent, again.request.traversal, null));
  }

  /** `submitVerified`'s undo/redo branch: local validation, then the one commit path. */
  private submitTraversalCommand(inputs: CommitInputs): Promise<FinalizeResult> | FinalizeResult {
    if (this.current.kind === "disabled") return { kind: "refused", reason: "disabled" };
    if (this.current.kind !== "idle") return { kind: "refused", reason: "not-idle" };
    const refusal = this.traversalRefusal(inputs);
    if (refusal) return { kind: "refused", reason: refusal };
    return this.sendCommit(inputs);
  }

  /**
   * The direct path's refusals: identity first (Q5 and unknown targets), then
   * the shared validity rule (a stale target is refused), then that the
   * submitted command and the proof's base are exactly what the log derives
   * now — the same request `prepareTraversal` would have produced.
   */
  private traversalRefusal(inputs: CommitInputs): FinalizeRefusalReason | null {
    const traversal = inputs.traversal;
    if (!traversal || traversal.direction !== inputs.intent) return "unknown-traversal-target";
    if (this.log.isTraversalOperation(traversal.operationId)) return "traversal-of-traversal";
    const target = this.log.target(traversal.direction);
    if (!target || target.entry.operationId !== traversal.operationId) return "unknown-traversal-target";
    const derived = this.deriveTraversalRequest(traversal.direction);
    if (!derived.ok) return derived.reason === "stale-log" ? "stale-log" : "target-changed";
    if (canonicalJson(inputs.command) !== canonicalJson(derived.request.command) || inputs.proof.baseEditorRevision !== derived.request.baseEditorRevision) {
      return "target-changed";
    }
    return null;
  }

  private async sendCommit(inputs: CommitInputs): Promise<FinalizeResult> {
    const { command, proof, intent, traversal } = inputs;
    // Operation-ID ruling: minted once per commit attempt, at `finalize`
    // (i.e. here), reused verbatim for every poll, never derived from the
    // request. A fresh one is minted only on the NEXT call, after this
    // attempt reaches a definite answer.
    const operationId = this.deps.uuid();
    const request: EditorCommitRequest = {
      version: 1,
      baseEditorRevision: proof.baseEditorRevision,
      command,
      intent,
      traversal,
      operationId,
      proofId: proof.proofId
    };
    const beginForState = this.current.kind === "preview-ok" ? this.current.begin : null;
    const draft = this.buildDraft(inputs, operationId, beginForState);
    this.setState({ kind: "committing", begin: beginForState, operationId, receipt: null });

    return new Promise<FinalizeResult>((resolve) => {
      const record: ActiveCommit = { operationId, resolveFinalize: resolve, aborted: false, intent, traversal, draft };
      this.activeCommit = record;
      this.deps.client.commit(this.deps.projectId, request).then((outcome) => {
        this.handleCommitOutcome(record, outcome);
      });
    });
  }

  /** The log entry an accepted `edit`/`setup` receipt will append. `null` for undo/redo — those never append (Q5). */
  private buildDraft(inputs: CommitInputs, operationId: string, begin: BeginInput | null): EntryDraft | null {
    if (inputs.intent !== "edit" && inputs.intent !== "setup") return null;
    const { command, context } = inputs;
    const common = { operationId, intent: inputs.intent, command, ...(context && "beforeFeature" in context ? { beforeFeature: context.beforeFeature } : {}) };
    switch (command.kind) {
      case "set-value": {
        const fromBegin = begin && begin.featureId === command.featureId ? begin.baseValue : null;
        return {
          ...common,
          featureId: command.featureId,
          bindingVersion: command.bindingVersion,
          beforeValue: context?.beforeValue ?? fromBegin,
          afterValue: command.value
        };
      }
      case "put-feature":
        return {
          ...common,
          featureId: command.feature.featureId,
          bindingVersion: command.feature.bindingVersion,
          beforeValue: null,
          afterValue: null
        };
      case "remove-feature":
        return { ...common, featureId: command.featureId, bindingVersion: command.bindingVersion, beforeValue: null, afterValue: null };
    }
  }

  private handleCommitOutcome(record: ActiveCommit, outcome: CommitOutcome): void {
    if (record.aborted) return; // detach()/dispose() already settled this attempt
    if (outcome.kind === "definite") {
      this.settleDefinite(record, outcome);
      return;
    }
    this.setState({ kind: "resolving", begin: null, operationId: record.operationId, attempt: 1 });
    this.scheduleLookup(record, 1);
  }

  private scheduleLookup(record: ActiveCommit, attempt: number): void {
    const delay = resolvingBackoffDelayMs(attempt);
    this.resolvingTimerHandle = this.deps.timer.setTimeout(() => {
      this.resolvingTimerHandle = null;
      if (record.aborted) return;
      this.deps.client.lookupOperation(this.deps.projectId, record.operationId).then((outcome) => {
        if (record.aborted) return;
        if (outcome.kind === "definite") {
          this.settleDefinite(record, outcome);
          return;
        }
        // `unknown` (and every other ambiguous cause) keeps polling and is
        // never presented as rejected.
        this.setState({ kind: "resolving", begin: null, operationId: record.operationId, attempt: attempt + 1 });
        this.scheduleLookup(record, attempt + 1);
      });
    }, delay);
  }

  private settleDefinite(record: ActiveCommit, outcome: Extract<CommitOutcome, { kind: "definite" }>): void {
    // A late callback must belong to this controller and to the commit that is
    // still current: disposed, detached or already-settled records do nothing.
    if (record.aborted || this.disposed || this.activeCommit !== record) return;
    this.activeCommit = null;
    const response = outcome.response;
    if (response.state === "committed") {
      // The ONLY place the session log changes for a commit: exactly once, on
      // the accepted receipt (spec §5.3). Rejections, ambiguity, detach and
      // cancel never reach here.
      this.applyReceiptToLog(record, response.receipt);
      // R3: stay `committing`, port locked, until the host confirms a
      // coherent read at this exact `editorRevision` — see
      // `notifyDocumentRevision`/`notifyDisplayFailure`. `finalize` still
      // resolves now, at the receipt.
      this.setState({ kind: "committing", begin: null, operationId: record.operationId, receipt: response.receipt });
      this.secondTabDetector.announceCommitted(record.operationId);
      record.resolveFinalize({ kind: "committed", receipt: response.receipt });
      return;
    }
    this.setState({ kind: "idle" });
    this.recomputeIdleDisabled();
    record.resolveFinalize({ kind: "rejected", reason: response.reason, error: response.error });
  }

  /** Edit/setup receipts append; undo/redo receipts only move the cursor. */
  private applyReceiptToLog(record: ActiveCommit, receipt: EditorReceipt): void {
    if (record.intent === "undo" || record.intent === "redo") {
      if (record.traversal) this.log.applyTraversal(record.traversal, receipt);
      return;
    }
    if (record.draft) this.log.appendFresh(record.draft, receipt, new Date(this.deps.clock()).toISOString());
  }

  // ── navigation receipts (spec §5.5) ──────────────────────────────────────

  /**
   * Looks up every operation recorded for THIS project when it was last left
   * mid-commit. Runs once at construction; idempotent while running. Results
   * go to `onPendingReconciled` only — never into this controller's state or
   * log, and never to another project (the store is keyed by project and the
   * lookup uses this controller's own `projectId`).
   */
  reconcilePending(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.reconcileRun) return this.reconcileRun;
    const records = this.pendingReceipts.list(this.deps.projectId);
    if (records.length === 0) return Promise.resolve();
    // Cleared on fulfilment AND rejection, so one failed run never blocks the next.
    const run = Promise.all(records.map((record) => this.reconcileOne(record, 1))).then(
      () => {
        if (this.reconcileRun === run) this.reconcileRun = null;
      },
      (cause: unknown) => {
        if (this.reconcileRun === run) this.reconcileRun = null;
        throw cause;
      }
    );
    this.reconcileRun = run;
    return run;
  }

  private async reconcileOne(record: PendingReceiptRecord, attempt: number): Promise<void> {
    if (this.disposed) return; // re-checked before every lookup, including after a backoff wait
    let outcome: CommitOutcome;
    try {
      outcome = await this.deps.client.lookupOperation(this.deps.projectId, record.operationId);
    } catch {
      outcome = { kind: "ambiguous", cause: "network-error" };
    }
    // Re-validated after the await: disposed, or someone else already settled it.
    if (this.disposed || !this.pendingReceipts.has(this.deps.projectId, record.operationId)) return;
    if (outcome.kind === "ambiguous") {
      // Still unknown: never treated as rejected, never dropped. Keep polling.
      await new Promise<void>((resolve) => {
        const handle = this.deps.timer.setTimeout(() => {
          this.reconcileWaits.delete(handle);
          resolve();
        }, resolvingBackoffDelayMs(attempt));
        this.reconcileWaits.set(handle, resolve);
      });
      return this.reconcileOne(record, attempt + 1);
    }
    this.pendingReceipts.remove(this.deps.projectId, record.operationId);
    const response = outcome.response;
    const reconciliation: PendingReconciliation =
      response.state === "committed"
        ? { operationId: record.operationId, outcome: "committed", receipt: response.receipt }
        : { operationId: record.operationId, outcome: "not-committed", reason: response.reason };
    try {
      this.deps.onPendingReconciled?.(reconciliation);
    } catch {
      // A host hook failure must neither reject the run nor stop the other
      // records: the record is already reconciled and removed.
    }
  }

  // ── detach / dispose (R2) ─────────────────────────────────────────────────

  /**
   * Project switch: stops polling and resolves the pending `finalize`/
   * `submitVerified` with `{ kind: "detached" }` so C3 can record a pending
   * navigation receipt. Returns the operation ID that was in flight, or
   * `null` if nothing was.
   *
   * Also settles a `finalize`/`submitVerified` still waiting on the port
   * (`preview-pending`, no operation minted yet) with `{ kind: "cancelled" }`
   * — never a hung promise.
   */
  detach(): string | null {
    const pending = this.pendingCommit;
    if (pending) {
      this.pendingCommit = null;
      this.port.reset(this.freshPortGeneration());
      this.setState({ kind: "idle" });
      this.recomputeIdleDisabled();
      pending.resolve({ kind: "cancelled" });
    }

    // Navigation discards the in-memory log (Q2, spec §5.3); history stays
    // available through revert.
    if (this.log.reset()) this.emit();

    const record = this.activeCommit;
    if (!record) return null;
    record.aborted = true;
    this.activeCommit = null;
    if (this.resolvingTimerHandle !== null) {
      this.deps.timer.clearTimeout(this.resolvingTimerHandle);
      this.resolvingTimerHandle = null;
    }
    this.setState({ kind: "idle" });
    this.recomputeIdleDisabled();
    // Spec §5.5: remember the in-flight operation for this project so a later
    // controller for it can reconcile instead of losing the receipt.
    this.pendingReceipts.record({
      projectId: this.deps.projectId,
      operationId: record.operationId,
      intent: record.intent,
      traversal: record.traversal
    });
    record.resolveFinalize({ kind: "detached", operationId: record.operationId });
    return record.operationId;
  }

  /** Full teardown for the host's unmount lifecycle. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.unsubscribePort();
    // Cancel the backoff timers AND settle the promises awaiting them, so an
    // awaited `reconcilePending()` completes; `reconcileOne` then sees
    // `disposed` and performs no further lookup.
    for (const [handle, settle] of this.reconcileWaits) {
      this.deps.timer.clearTimeout(handle);
      settle();
    }
    this.reconcileWaits.clear();
    this.secondTabDetector.close();
    this.listeners.clear();
  }

  // ── internal ───────────────────────────────────────────────────────────

  private setState(next: ControllerState): void {
    this.current = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
