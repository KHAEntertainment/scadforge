// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — transaction controller core: shared types.
//
// Governing spec: epics/.../s3-s4-plan/s3-contract/s3-c-transaction-controller
// (states §3.1, transitions §3.2, guards §3.3, cancel reasons §3.4, no-op
// §3.5, API surface §4.1) and the ticket story's operation-ID ruling, both
// amended per the Tech-Lead ruling on Issue #113 (see PR description).
//
// This module defines types only — no logic. `controller.ts` is the state
// machine; `port.ts` is the recording port; `backoff.ts` is the resolving
// poll schedule; `broadcastChannel.ts` is the second-tab primitive.

import type {
  ApiError,
  EditorCommand,
  EditorCommitRequest,
  EditorEligibility,
  EditorFeature,
  EditorIntent,
  EditorOperationResponse,
  EditorProofResponse,
  EditorReceipt,
  EditorSidecarStatus,
  EditorTraversal,
  EditorVerifyRequest
} from "@scadforge/protocol";
import type { PendingReceiptStore } from "./pendingReceipts.js";

// ═════════════════════════════════════════════════════════════════════════
// States (spec §3.1)
// ═════════════════════════════════════════════════════════════════════════

/** How a candidate value entered the transaction. */
export type CandidateSource = "drag" | "typed" | "setup" | "undo" | "redo";

/** Input captured at `begin`; frozen for the lifetime of the transaction. */
export interface BeginInput {
  featureId: string;
  bindingVersion: number;
  baseEditorRevision: string;
  sourceFingerprint: string;
  sidecarStatus: EditorSidecarStatus;
  /**
   * This feature's current eligibility entry, or `null` when the feature is
   * not listed (fully eligible — no fresh proof required to begin).
   */
  eligibility: EditorEligibility | null;
  /**
   * An already-obtained, not-yet-expired proof for this exact feature, if
   * the caller has one in hand at `begin` time. Only consulted when
   * `eligibility.state === "requires-proof"`.
   */
  freshProof: EditorProofResponse | null;
  /**
   * The authoritative value of this binding at `baseEditorRevision` — what
   * is currently displayed. `propose`'s no-op short-circuit (spec §3.5)
   * compares each candidate against this.
   */
  baseValue: number;
}

/** A proposed candidate value plus the source it arrived from. */
export interface Candidate {
  value: number;
  source: CandidateSource;
}

export type ControllerState =
  | { kind: "idle" }
  | { kind: "gesture"; begin: BeginInput }
  | { kind: "preview-pending"; begin: BeginInput; candidate: Candidate; portGeneration: number }
  | { kind: "preview-ok"; begin: BeginInput; candidate: Candidate; portGeneration: number }
  | { kind: "preview-failed"; begin: BeginInput; candidate: Candidate }
  | {
      kind: "committing";
      begin: BeginInput | null;
      operationId: string;
      /** Set once a `committed` receipt is known; commit is still port-locked until coherence. */
      receipt: EditorReceipt | null;
    }
  | { kind: "resolving"; begin: BeginInput | null; operationId: string; attempt: number }
  | { kind: "cancelling"; reason: CancelReason }
  | { kind: "disabled"; reason: DisabledReason };

// ═════════════════════════════════════════════════════════════════════════
// Cancel reasons (spec §3.4) — exactly six, never a seventh.
// ═════════════════════════════════════════════════════════════════════════

export type CancelReason =
  | "escape"
  | "pointercancel"
  | "lostpointercapture"
  | "window-blur"
  | "tool-change"
  | "unmount";

// ═════════════════════════════════════════════════════════════════════════
// Disabled reasons (spec §10.2 Q3, amended) — exactly six.
// ═════════════════════════════════════════════════════════════════════════

export type DisabledReason =
  | "sidecar-unreadable"
  | "source-dirty"
  | "params-pending"
  | "agent-turn-running"
  | "external-write-unsettled"
  | "display-recovering";

/**
 * Guard inputs the host pushes on every change (`controller.setGuardInputs`)
 * so the controller can transition `idle ↔ disabled` proactively rather than
 * only refusing `begin`. `sidecarStatus` maps `corrupt`/`missing`/
 * `unsupported-version` to `sidecar-unreadable`; `ready`/`legacy-empty` do
 * not disable.
 */
export interface GuardInputsSnapshot {
  sidecarStatus: EditorSidecarStatus;
  sourceDirty: boolean;
  sourceConflict: boolean;
  paramsDirty: boolean;
  paramsSaving: boolean;
  agentTurnRunning: boolean;
  /** From C1's `invalidate()`, cleared once its re-read completes. */
  externalWriteUnsettled: boolean;
}

// ═════════════════════════════════════════════════════════════════════════
// Begin / propose / finalize results
// ═════════════════════════════════════════════════════════════════════════

export type BeginRefusalReason =
  | DisabledReason
  | "not-idle"
  | "proof-required"
  | "feature-unsupported";

export type BeginResult = { ok: true } | { ok: false; reason: BeginRefusalReason };

export type ProposeRefusalReason =
  | "not-in-gesture"
  /** `Number.isFinite(candidate)` is false — NaN/±Infinity would also defeat the no-op guard (`NaN === base` is always false). */
  | "non-finite-candidate"
  /** A `finalize`/`submitVerified` call is already waiting on the port; changing the candidate underneath it could commit a stale value (spec §3.3's "candidate equals the latest port value" guard). */
  | "finalize-pending";

export type ProposeResult =
  | { ok: true; state: ControllerState }
  | { ok: false; reason: ProposeRefusalReason }
  /** No-op short-circuit (spec §3.5): candidate equals the authoritative value. Zero side effects. */
  | { ok: true; noOp: true };

export type FinalizeResult =
  | { kind: "committed"; receipt: EditorReceipt }
  | {
      kind: "rejected";
      reason: "unclaimed" | "rejected" | "aborted";
      error: ApiError | null;
    }
  /** `dispose()`/`detach()` (or `cancel("unmount")` mid-commit) aborted while awaiting a definite answer. */
  | { kind: "detached"; operationId: string }
  /**
   * `finalize`/`submitVerified` was waiting on the port (Failure A) and the
   * preview render failed instead of confirming. The transaction is in
   * `preview-failed`, recoverable via `cancel` + a fresh `begin` — it never
   * strands.
   */
  | { kind: "preview-failed" }
  /**
   * `finalize`/`submitVerified` was waiting on the port (preview-pending)
   * when the transaction was cancelled or invalidated (spec §2.3 external
   * write) before a sample ever confirmed. No command was sent.
   */
  | { kind: "cancelled" }
  /**
   * The call was refused locally; no command was sent, no state changed, and
   * any earlier wait is untouched. `finalize-pending` mirrors `propose`'s
   * refusal of the same name (a second `finalize`/`submitVerified` while the
   * first is still waiting on the port); the rest are undo/redo refusals
   * (spec §5.4, Q5).
   */
  | { kind: "refused"; reason: FinalizeRefusalReason };

export type FinalizeRefusalReason =
  | "finalize-pending"
  /** An undo/redo whose traversal names no entry at the cursor (or whose direction disagrees with its intent). */
  | "unknown-traversal-target"
  /** An undo/redo naming an accepted undo/redo — Q5: no undo of an undo. */
  | "traversal-of-traversal"
  /** `submitTraversal` re-derived a different request than the one the host verified. */
  | "target-changed"
  | "not-idle"
  | "disabled";

// ═════════════════════════════════════════════════════════════════════════
// Injected dependencies (design hint: plain class, injected client/clock/
// timer/UUID source/channel factory; guard inputs pushed via a setter).
// ═════════════════════════════════════════════════════════════════════════

/** Why a commit/lookup attempt could not be classified as a definite answer. */
export type AmbiguousCause =
  | "network-error"
  | "timeout"
  | "http-5xx"
  | "unparseable-body"
  | "server-unknown";

type DefiniteOperationResponse = Extract<
  EditorOperationResponse,
  { state: "committed" | "definitely_not_committed" }
>;

export type CommitOutcome =
  | { kind: "definite"; response: DefiniteOperationResponse }
  | { kind: "ambiguous"; cause: AmbiguousCause };

/** Structurally identical to {@link CommitOutcome} — used for `GET .../operations/:operationId` polls. */
export type LookupOutcome = CommitOutcome;

/**
 * The transport seam C1 implements against `apps/web/src/lib/apiClient.ts`.
 * C1 owns classification of transport failures (network error, timeout,
 * 5xx, unparseable body) into `ambiguous`; this controller never inspects
 * `fetch`/HTTP details itself. `verify` (`POST .../editor/verify`) is
 * deliberately not part of this seam — the typed path receives its proof
 * from the caller via `submitVerified`, and C2 never calls verify itself.
 */
export interface EditorClient {
  commit(projectId: string, request: EditorCommitRequest): Promise<CommitOutcome>;
  lookupOperation(projectId: string, operationId: string): Promise<LookupOutcome>;
}

// ═════════════════════════════════════════════════════════════════════════
// Session log, traversal and navigation receipts (C3, spec §5)
// ═════════════════════════════════════════════════════════════════════════

/**
 * What a caller knows about the state a command replaces, which the log
 * needs to rebuild an exact inverse (the server's traversal check is by
 * canonical JSON). `finalize` derives `beforeValue` from `begin.baseValue`;
 * `submitVerified` takes it from here.
 */
export interface SubmitContext {
  beforeValue?: number | null;
  /** The feature as it was before: `null` when the command creates it. */
  beforeFeature?: EditorFeature | null;
}

export type TraversalDirection = EditorTraversal["direction"];

export type TraversalRefusalReason =
  | "nothing-to-undo"
  | "nothing-to-redo"
  | "not-idle"
  | "disabled"
  /** The cursor entry was invalidated by an external write, or the controller has no known tip revision. */
  | "stale-log"
  /** The cursor entry lacks the recorded before/after data needed to build the exact inverse. */
  | "not-traversable";

/** The complete verify request the host passes unchanged to `verifyEditorCommand`. */
export interface PreparedTraversal {
  request: EditorVerifyRequest;
}

export type PrepareTraversalResult =
  | { ok: true; request: EditorVerifyRequest }
  | { ok: false; reason: TraversalRefusalReason };

/** Reported when a recorded navigation receipt is looked up on return to its project. */
export type PendingReconciliation =
  | { operationId: string; outcome: "committed"; receipt: EditorReceipt }
  | { operationId: string; outcome: "not-committed"; reason: "unclaimed" | "rejected" | "aborted" };

/** Injectable UUIDv4 source — swapped for a deterministic sequence in tests. */
export type UuidSource = () => string;

/** Injectable wall clock — swapped for a fixed/advancing value in tests. */
export type Clock = () => number;

/** Injectable timer, matching the subset of `setTimeout`/`clearTimeout` the backoff loop needs. */
export interface TimerLike {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

/** Minimal `BroadcastChannel`-shaped surface — see `broadcastChannel.ts`. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike;

export interface TransactionControllerDeps {
  projectId: string;
  client: EditorClient;
  clock: Clock;
  timer: TimerLike;
  uuid: UuidSource;
  broadcastChannelFactory: BroadcastChannelFactory;
  /** Invoked when a peer tab's `committed` broadcast arrives (Q4). */
  onPeerCommitted: () => void;
  /**
   * Per-project pending navigation receipts (spec §5.5). Defaults to the
   * page-lifetime `sharedPendingReceipts`; the host owns its lifetime. Tests
   * inject a fresh store.
   */
  pendingReceipts?: PendingReceiptStore;
  /**
   * Called once a navigation-pending operation is reconciled on return to
   * this controller's project (never after `dispose()`), so the host can
   * re-read the document. The result is not painted anywhere by the
   * controller.
   */
  onPendingReconciled?: (reconciliation: PendingReconciliation) => void;
}

export type {
  ApiError,
  EditorCommand,
  EditorCommitRequest,
  EditorEligibility,
  EditorFeature,
  EditorIntent,
  EditorProofResponse,
  EditorReceipt,
  EditorSidecarStatus,
  EditorTraversal,
  EditorVerifyRequest
};
