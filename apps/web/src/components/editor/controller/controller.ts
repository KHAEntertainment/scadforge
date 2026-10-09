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

import type { EditorCommitRequest, EditorProofResponse } from "@scadforge/protocol";
import { resolvingBackoffDelayMs } from "./backoff.js";
import { SecondTabDetector } from "./broadcastChannel.js";
import { TransactionPort, type TransactionPortWriter } from "./port.js";
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
  FinalizeResult,
  GuardInputsSnapshot,
  ProposeResult,
  TransactionControllerDeps
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

  constructor(private readonly deps: TransactionControllerDeps) {
    this.secondTabDetector = new SecondTabDetector(
      deps.broadcastChannelFactory,
      deps.projectId,
      deps.onPeerCommitted
    );
    this.unsubscribePort = this.port.subscribe(() => this.handlePortChange());
  }

  // ── observation ────────────────────────────────────────────────────────

  state(): ControllerState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The writer half C4's preview adapter writes samples to. */
  get portWriter(): TransactionPortWriter {
    return this.port;
  }

  // ── guard inputs / disabled (spec §10.2 Q3, amended) ─────────────────────

  setGuardInputs(inputs: GuardInputsSnapshot): void {
    if (this.disposed) return;
    this.guardInputs = inputs;
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
    this.setState({ kind: "idle" });
    this.recomputeIdleDisabled();
  }

  notifyDisplayRecovered(): void {
    if (this.disposed || !this.displayRecovering) return;
    this.displayRecovering = false;
    this.recomputeIdleDisabled();
  }

  /**
   * The host's document cache reports a coherent read at `editorRevision`
   * (R3). If the controller is `committing` awaiting exactly this revision,
   * it is now safe to go `idle` — going idle on the receipt alone would let
   * the next `begin` capture a stale `baseEditorRevision` (a pointless 409).
   */
  notifyDocumentRevision(editorRevision: string): void {
    if (this.disposed) return;
    if (this.current.kind !== "committing" || !this.current.receipt) return;
    if (this.current.receipt.editorRevision !== editorRevision) return;
    this.setState({ kind: "idle" });
    this.recomputeIdleDisabled();
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
   */
  async finalize(proof: EditorProofResponse): Promise<FinalizeResult> {
    if (this.current.kind === "preview-ok") {
      return this.sendCommit(this.buildSetValueCommand(this.current.begin, this.current.candidate.value), proof, "edit", null);
    }
    if (this.current.kind === "preview-pending") {
      const begin = this.current.begin;
      const candidateValue = this.current.candidate.value;
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
            this.sendCommit(this.buildSetValueCommand(begin, candidateValue), proof, "edit", null).then(resolve);
          }
        };
      });
    }
    throw new Error(`finalize() called from unexpected state "${this.current.kind}"`);
  }

  /**
   * The direct-command path: `intent`/`traversal` default to a plain edit
   * (typed entry's usual call). C3 passes `intent: "undo"|"redo"` with a
   * traversal for cursor navigation; S4-A passes `intent: "setup"` for
   * `put-feature`/`remove-feature`. Usable from `idle` (undo/redo/setup have
   * no drag gesture) or from an active gesture, waiting on the port the same
   * way `finalize` does.
   */
  async submitVerified(
    command: EditorCommand,
    proof: EditorProofResponse,
    intent: EditorIntent = "edit",
    traversal: EditorTraversal | null = null
  ): Promise<FinalizeResult> {
    if (this.current.kind === "idle" || this.current.kind === "preview-ok") {
      return this.sendCommit(command, proof, intent, traversal);
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
            this.sendCommit(command, proof, intent, traversal).then(resolve);
          }
        };
      });
    }
    throw new Error(`submitVerified() called from unexpected state "${this.current.kind}"`);
  }

  private buildSetValueCommand(begin: BeginInput, value: number): EditorCommand {
    return { kind: "set-value", featureId: begin.featureId, bindingVersion: begin.bindingVersion, value };
  }

  private async sendCommit(
    command: EditorCommand,
    proof: EditorProofResponse,
    intent: EditorIntent,
    traversal: EditorTraversal | null
  ): Promise<FinalizeResult> {
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
    this.setState({ kind: "committing", begin: beginForState, operationId, receipt: null });

    return new Promise<FinalizeResult>((resolve) => {
      const record: ActiveCommit = { operationId, resolveFinalize: resolve, aborted: false };
      this.activeCommit = record;
      this.deps.client.commit(this.deps.projectId, request).then((outcome) => {
        this.handleCommitOutcome(record, outcome);
      });
    });
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
    if (record.aborted) return;
    if (this.activeCommit === record) this.activeCommit = null;
    const response = outcome.response;
    if (response.state === "committed") {
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
    record.resolveFinalize({ kind: "detached", operationId: record.operationId });
    return record.operationId;
  }

  /** Full teardown for the host's unmount lifecycle. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.unsubscribePort();
    this.secondTabDetector.close();
    this.listeners.clear();
  }

  // ── internal ───────────────────────────────────────────────────────────

  private setState(next: ControllerState): void {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
