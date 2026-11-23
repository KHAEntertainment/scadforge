// SPDX-License-Identifier: Apache-2.0
//
// S3-C C1 — commit/lookup outcome classification (Issue #134 criterion 3).
//
// Pure functions: one transport attempt plus the operation id's attempt
// context in, a `CommitOutcome`/`LookupOutcome` out. The rules (Issue #134
// wins over the ticket artifact's superseded "4xx is definite" table):
//
//  - First attempt of an id: a 200 receipt is definite `committed`; a 4xx
//    with a parseable `ApiError` is definite `definitely_not_committed` (the
//    error passed through unchanged); a network error, timeout, 5xx or
//    unparseable body is ambiguous.
//  - After any ambiguous attempt of that id (and for every re-send of a
//    recorded request): only a 200 receipt is definite from the transport. A
//    4xx is NOT definite — the server answers `CONFLICT`/409 when its lock
//    wait deadline passes BEFORE it inspects the operation id, so a retry can
//    get 409 while the original request still holds the lock and commits.
//  - Lookup answers: `committed` and `definitely_not_committed` with reason
//    `rejected`/`aborted` are terminal claims and definite. `unclaimed` is
//    never definite for an id whose commit attempt was ambiguous — the
//    original POST can still be queued and commit later. `unknown` is
//    ambiguous and never presented as rejected.
//  - Tech-Lead ruling R1: any transport failure of the LOOKUP route is
//    ambiguous whatever the status — a lookup 4xx is never a rejection of the
//    operation (the lookup takes the same project lock and can itself get
//    409). R2: an id this adapter holds no ambiguous-commit record for passes
//    the server's parsed answer through unchanged.
//
// No code here reads error message text (Issue #134 criterion 4): every
// `CONFLICT` variant shares one error code and one classification path.

import type { ApiError, EditorOperationResponse, EditorReceipt } from "@scadforge/protocol";
import type { AmbiguousCause, CommitOutcome, LookupOutcome } from "../controller/types.js";

/** Why one transport attempt produced no classifiable answer. */
export type AttemptFailure =
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "unparseable-body" }
  /** Non-2xx with a parseable `ApiError` body (the only classifiable 4xx/5xx). */
  | { kind: "http"; status: number; apiError: ApiError };

/** One `POST .../editor/commands` attempt. */
export type CommitAttempt =
  | { ok: true; receipt: EditorReceipt }
  | { ok: false; failure: AttemptFailure };

/** One `GET .../editor/operations/:operationId` attempt. */
export type LookupAttempt =
  | { ok: true; response: EditorOperationResponse }
  | { ok: false; failure: AttemptFailure };

function failureCause(failure: AttemptFailure): AmbiguousCause {
  switch (failure.kind) {
    case "network":
      return "network-error";
    case "timeout":
      return "timeout";
    case "unparseable-body":
      return "unparseable-body";
    case "http":
      // 5xx is its own cause; a non-5xx non-4xx status (defensive — `fetch`
      // follows redirects) and any retry 4xx mean "the server's answer does
      // not determine this operation's terminal state".
      return failure.status >= 500 ? "http-5xx" : "server-unknown";
  }
}

/**
 * Classify one commit (POST) attempt.
 *
 * `context.retry` is true when this attempt is NOT the first for its
 * operation id — an earlier attempt of the same id already ran (an ambiguous
 * outcome was reported, or the adapter is re-sending a recorded request per
 * Issue #134 criterion 3). On a retry only a 200 receipt is definite.
 */
export function classifyCommitAttempt(
  attempt: CommitAttempt,
  context: { retry: boolean }
): CommitOutcome {
  if (attempt.ok) {
    // A 200 receipt is always definite: on the same id + same request digest
    // the server replays the stored receipt instead of re-applying.
    return { kind: "definite", response: { version: 1, state: "committed", receipt: attempt.receipt } };
  }
  const failure = attempt.failure;
  if (!context.retry && failure.kind === "http" && failure.status >= 400 && failure.status < 500) {
    // First attempt + 4xx + parseable ApiError: the server saw and refused
    // this exact request before anything could commit. The ApiError is passed
    // through unchanged (Issue #134 criterion 3).
    return {
      kind: "definite",
      response: {
        version: 1,
        state: "definitely_not_committed",
        requestDigest: null,
        reason: "rejected",
        error: failure.apiError
      }
    };
  }
  return { kind: "ambiguous", cause: failureCause(failure) };
}

/**
 * Classify one operation-lookup (GET) attempt (Issue #134 criterion 3).
 *
 * `context.hasAmbiguousCommit` is true when this adapter instance holds a
 * record of an AMBIGUOUS commit attempt for the id — only then is an
 * `unclaimed` answer withheld as non-definite (Tech-Lead ruling R2).
 */
export function classifyLookupAttempt(
  attempt: LookupAttempt,
  context: { hasAmbiguousCommit: boolean }
): LookupOutcome {
  // R1: any transport failure of the lookup route is ambiguous, whatever the
  // status — a lookup 4xx (e.g. its own lock-timeout CONFLICT) says nothing
  // about the operation.
  if (!attempt.ok) return { kind: "ambiguous", cause: failureCause(attempt.failure) };
  const response = attempt.response;
  if (response.state === "committed") return { kind: "definite", response };
  if (response.state === "unknown") return { kind: "ambiguous", cause: "server-unknown" };
  // state === "definitely_not_committed"
  if (response.reason === "unclaimed" && context.hasAmbiguousCommit) {
    // The original POST can still be queued before its claim is reserved and
    // commit later — never definite for an ambiguous id.
    return { kind: "ambiguous", cause: "server-unknown" };
  }
  // Terminal claims (`rejected`, `aborted`) and `unclaimed` for an id this
  // adapter holds no ambiguous-commit record for pass through unchanged.
  return { kind: "definite", response };
}
