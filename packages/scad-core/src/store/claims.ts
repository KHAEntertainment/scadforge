// @scadforge/scad-core — durable operation claims and idempotent replay
// (Issue #90, S3-B ticket B4).
//
// `.scadforge/editor-operations/<uuid>.json` is the durable claim a future
// editor command (B6) reserves BEFORE validation/proof so a retried or
// concurrently-duplicated request can never produce a second snapshot
// (wire-and-recovery §"Canonical identity and durable operation claims").
// B5 (proof) and B6 (routes, `EditorCommand` application) are both out of
// scope for this ticket — this module builds only the claim lifecycle and
// the pure replay rule, exercised directly by this ticket's own tests
// against a synthetic request/producer pair; B6 supplies the real one.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ApiError, EditorFeature, EditorReceipt } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";
import { operationPath, operationsDir, pendingClaimMarkerPath, pendingClaimsDir } from "./paths.js";
import type { LockedProject } from "./recovered.js";

/**
 * The before/after image an accepted operation needs for undo/redo inverse
 * derivation (wire-and-recovery §"Session cursor transitions": "Retain
 * before/after values and authored metadata in the original accepted
 * operation record"). Captured by B6's `commands.ts` AT COMMIT TIME from the
 * live root state under the same lock — never derived later by diffing the
 * accepted snapshot against its parent, which a `snapshot:false` params
 * write landing between them would make wrong (Tech Lead correction on
 * Issue #98). Internal disk shape only; NOT part of the frozen
 * `@scadforge/protocol` wire — a caller resolving a committed claim never
 * exposes this field on `EditorReceipt`.
 */
export type AcceptedOperationRecord =
  | { kind: "set-value"; featureId: string; bindingVersion: number; parameter: string; beforeValue: number; afterValue: number }
  /** `before: null` for a create (nothing existed at this featureId before). */
  | { kind: "put-feature"; featureId: string; before: EditorFeature | null; after: EditorFeature }
  | { kind: "remove-feature"; featureId: string; before: EditorFeature };

/** A claim's terminal outcome. `null` (absent from {@link OperationClaim}) means still pending — reserved, work not yet finished. */
export type ClaimTerminalState =
  | { kind: "rejected"; error: ApiError }
  | { kind: "aborted" }
  | { kind: "committed"; receipt: EditorReceipt; transactionId: string; accepted?: AcceptedOperationRecord };

/** The durable record at `.scadforge/editor-operations/<operationId>.json`. */
export interface OperationClaim {
  version: 1;
  operationId: string;
  requestDigest: string;
  /** The immutable original request. Opaque to this module — B6's `EditorCommitRequest` shape. */
  request: unknown;
  terminal: ClaimTerminalState | null;
}

async function readClaimLocked(ctx: LockedProject, operationId: string): Promise<OperationClaim | null> {
  try {
    return JSON.parse(await readFile(operationPath(ctx.projectDir, operationId), "utf8")) as OperationClaim;
  } catch {
    return null;
  }
}

async function writeClaimLocked(ctx: LockedProject, claim: OperationClaim): Promise<void> {
  await mkdir(operationsDir(ctx.projectDir), { recursive: true });
  const target = operationPath(ctx.projectDir, claim.operationId);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(claim, null, 2), "utf8");
  await rename(tmp, target);
}

// ═════════════════════════════════════════════════════════════════════════════
// Pending-claim marker set (S3-B ticket B6, carried B4 delta QA) — lets
// `recoverPendingClaimsLocked` (`store/transaction.ts`) sweep only claims
// still `terminal: null`, instead of listing and reading every claim a
// project has ever accumulated.
//
// Crash-safe ordering (Tech Lead correction C1 on Issue #98):
//   - RESERVE: write the marker FIRST, then the claim file. A crash between
//     leaves a stray marker with no claim file — the sweep's
//     `recordClaimAbortedLocked` finds nothing to abort and deletes the
//     marker. The reverse order would risk the opposite: a claim durably
//     `terminal: null` with no marker, invisible to the sweep — exactly the
//     "a young orphan must still resolve on the next entry" failure the
//     ticket rules out.
//   - RESOLVE (rejected/aborted/committed): write the terminal claim FIRST,
//     then remove the marker. A crash between leaves a marker pointing at an
//     already-terminal claim — the sweep self-heals (removes the marker
//     without touching or downgrading the claim).
// ═════════════════════════════════════════════════════════════════════════════

async function markClaimPendingLocked(ctx: LockedProject, operationId: string): Promise<void> {
  await mkdir(pendingClaimsDir(ctx.projectDir), { recursive: true });
  const target = pendingClaimMarkerPath(ctx.projectDir, operationId);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, "", "utf8");
  await rename(tmp, target);
}

/** Idempotent — a missing marker is not an error (the common case: most resolutions run right after their own reservation, in-process, with the marker already gone by the time a later caller looks). */
async function clearPendingMarkerLocked(ctx: LockedProject, operationId: string): Promise<void> {
  await rm(pendingClaimMarkerPath(ctx.projectDir, operationId), { force: true });
}

export type ReserveClaimResult =
  | { kind: "reserved" }
  /** Already reserved under the SAME digest — a retry of the exact request. `terminal` is whatever is durably known so far (often still `null`, i.e. pending). */
  | { kind: "same-request"; terminal: ClaimTerminalState | null }
  /** Reserved under a DIFFERENT digest — always CONFLICT, regardless of the existing claim's terminal state (wire-and-recovery: "different digest on any reserved ID always conflicts, including aborted/rejected IDs"). */
  | { kind: "conflict" };

/**
 * Durably reserves an operation claim BEFORE validation/proof — "malformed
 * requests that cannot be canonicalized reserve nothing" (wire-and-recovery)
 * means the caller computes `requestDigest` first and never calls this for a
 * request it could not canonicalize. Idempotent for the exact same
 * `(operationId, requestDigest)` pair.
 */
export async function reserveClaimLocked(
  ctx: LockedProject,
  operationId: string,
  requestDigest: string,
  request: unknown
): Promise<ReserveClaimResult> {
  const existing = await readClaimLocked(ctx, operationId);
  if (existing) {
    if (existing.requestDigest !== requestDigest) return { kind: "conflict" };
    return { kind: "same-request", terminal: existing.terminal };
  }
  // Marker before claim file — see the ordering note above `markClaimPendingLocked`.
  await markClaimPendingLocked(ctx, operationId);
  await writeClaimLocked(ctx, { version: 1, operationId, requestDigest, request, terminal: null });
  return { kind: "reserved" };
}

/** Records a definite rejection (a validation/proof failure) against an already-reserved claim. Never called for a claim that does not exist — reserve first. */
export async function recordClaimRejectedLocked(ctx: LockedProject, operationId: string, error: ApiError): Promise<void> {
  const existing = await readClaimLocked(ctx, operationId);
  if (!existing) {
    throw new ScadForgeError("INTERNAL_ERROR", `no reserved operation claim '${operationId}' to reject`);
  }
  // Claim file before marker removal — see the ordering note above `markClaimPendingLocked`.
  await writeClaimLocked(ctx, { ...existing, terminal: { kind: "rejected", error } });
  await clearPendingMarkerLocked(ctx, operationId);
}

/**
 * Recovery's row-1 action: a claim whose transaction crashed before
 * `commit.json` became durable is terminal `aborted`. A no-op (on the claim
 * itself) when nothing was durably reserved yet (the crash happened even
 * before the reserve write landed) or when the claim already carries a
 * DIFFERENT terminal state — never downgrade a committed/rejected claim to
 * aborted. Either no-op case still clears a lingering pending marker, so the
 * sweep that called this does not keep re-reading it (see the ordering note
 * above `markClaimPendingLocked`).
 */
export async function recordClaimAbortedLocked(ctx: LockedProject, operationId: string): Promise<void> {
  const existing = await readClaimLocked(ctx, operationId);
  if (!existing || existing.terminal !== null) {
    await clearPendingMarkerLocked(ctx, operationId);
    return;
  }
  await writeClaimLocked(ctx, { ...existing, terminal: { kind: "aborted" } });
  await clearPendingMarkerLocked(ctx, operationId);
}

/** `store/transaction.ts`'s `publishLocked` calls this to materialize a claim's `committed` terminal state once its transaction is fully published. */
export async function recordClaimCommittedLocked(
  ctx: LockedProject,
  operationId: string,
  outcome: { receipt: EditorReceipt; transactionId: string; accepted?: AcceptedOperationRecord }
): Promise<void> {
  const existing = await readClaimLocked(ctx, operationId);
  const base: OperationClaim = existing ?? {
    version: 1,
    operationId,
    requestDigest: outcome.receipt.requestDigest,
    request: null,
    terminal: null
  };
  await writeClaimLocked(ctx, {
    ...base,
    terminal: { kind: "committed", receipt: outcome.receipt, transactionId: outcome.transactionId, accepted: outcome.accepted }
  });
  await clearPendingMarkerLocked(ctx, operationId);
}

/**
 * Mirrors the spec's `EditorOperationResponse` shape exactly (wire-and-
 * recovery §"Canonical identity and durable operation claims"): an unclaimed
 * lookup is `definitely_not_committed` with `reason: "unclaimed"`, NOT its
 * own top-level kind — Tech Lead correction on Issue #90 AC6. `committed`
 * and `unknown` are the only other two states.
 */
export type ClaimLookupResult =
  | { kind: "committed"; receipt: EditorReceipt; accepted?: AcceptedOperationRecord }
  | { kind: "definitely_not_committed"; requestDigest: string | null; reason: "unclaimed" | "rejected" | "aborted"; error: ApiError | null }
  | { kind: "unknown"; requestDigest: string | null };

/**
 * The read side of a `GET .../editor/operations/:id` (B6's route calls this)
 * AND of B6's own undo/redo traversal, which resolves `traversal.operationId`
 * through this same function to reach the original accepted operation's
 * `accepted` before/after record — `accepted` is internal-only (never part of
 * the frozen `EditorReceipt`/`EditorOperationResponse` wire); a caller
 * building the wire response simply does not forward it.
 */
export async function lookupClaimLocked(ctx: LockedProject, operationId: string): Promise<ClaimLookupResult> {
  const claim = await readClaimLocked(ctx, operationId);
  if (!claim) return { kind: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null };
  if (claim.terminal === null) return { kind: "unknown", requestDigest: claim.requestDigest };
  if (claim.terminal.kind === "committed") {
    return { kind: "committed", receipt: claim.terminal.receipt, accepted: claim.terminal.accepted };
  }
  if (claim.terminal.kind === "rejected") {
    return { kind: "definitely_not_committed", requestDigest: claim.requestDigest, reason: "rejected", error: claim.terminal.error };
  }
  return { kind: "definitely_not_committed", requestDigest: claim.requestDigest, reason: "aborted", error: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// Pure replay helpers (Issue #90 AC6) — B6 calls these; this ticket's own
// tests exercise them directly since B5/B6 are out of scope.
// ═════════════════════════════════════════════════════════════════════════════

/** The exact wire-and-recovery message for a resubmission against a recovered-aborted claim. */
export const ABORTED_REPLAY_MESSAGE = "Operation was aborted before commit; refresh and submit a new operation.";

export type ReplayDecision =
  /** Same id, same digest, terminal — return this cached result, never re-run the operation. */
  | { kind: "replay"; terminal: ClaimTerminalState }
  /** Same id, same digest, not yet terminal — another submission of the identical request is still in flight; wait, never re-run. */
  | { kind: "pending" }
  /** Same id, different digest (including against an aborted/rejected claim) — always CONFLICT. */
  | { kind: "conflict"; message: string | null }
  /** No existing claim for this id — the caller may reserve and proceed. */
  | { kind: "proceed" };

/**
 * Pure (no I/O): given whatever is already durably claimed for an operation
 * id (or `null` if unclaimed) and the digest of the INCOMING request, decides
 * whether to replay a cached terminal result, wait, conflict, or proceed.
 * Callers resolve the claim lookup themselves (typically via
 * {@link lookupClaimLocked} or a raw {@link OperationClaim}) and pass it in —
 * this function never touches disk.
 */
export function decideReplay(existing: OperationClaim | null, incomingDigest: string): ReplayDecision {
  if (!existing) return { kind: "proceed" };
  if (existing.requestDigest !== incomingDigest) return { kind: "conflict", message: null };
  if (existing.terminal === null) return { kind: "pending" };
  if (existing.terminal.kind === "aborted") return { kind: "conflict", message: ABORTED_REPLAY_MESSAGE };
  return { kind: "replay", terminal: existing.terminal };
}
