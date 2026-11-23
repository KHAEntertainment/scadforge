// SPDX-License-Identifier: Apache-2.0
//
// S3-C C1 — the real `EditorClient` seam implementation (Issue #134).
//
// Implements C2's transport seam (`../controller/types.ts`, unchanged)
// against `apps/web/src/lib/apiClient.ts`'s four editor methods. Per
// operation id it keeps the exact submitted request so an ambiguous attempt
// can be recovered exactly as Issue #134 criterion 3 requires:
//
//  - the adapter never mints or changes an operation id (C2 owns ids) and
//    never changes the request between attempts — a re-send is byte-identical
//    (criterion 7), and a caller that submits different bytes under a used id
//    gets a plain programming `Error` (Tech-Lead ruling R3);
//  - `lookupOperation` handles the `unclaimed` recovery: it re-sends the
//    recorded request (at most one in flight per id) and reports ambiguous
//    until a rule-2 definite answer exists (a 200 receipt replay, or a
//    terminal claim read through the lookup route);
//  - a definite rejection whose frozen code is `CONFLICT` is reported through
//    an injected callback so the document cache can invalidate and re-read
//    without this module ever importing React or reading message text
//    (criterion 4).
//
// Timeouts (R4): each attempt is raced against a timeout; after a reported
// `timeout` a late settlement of that attempt is stored iff it proves a
// definite answer (a late 200 receipt, or a terminal claim), and any late
// non-definite settlement is ignored — the id stays ambiguous and resolves
// through the lookup route.

import type { EditorCommitRequest } from "@scadforge/protocol";
import { ApiClientError } from "../../../lib/apiClient.js";
import type { ApiClient } from "../../../lib/apiClient.js";
import type {
  CommitOutcome,
  EditorClient,
  LookupOutcome,
  TimerLike
} from "../controller/types.js";
import {
  classifyCommitAttempt,
  classifyLookupAttempt,
  type AttemptFailure,
  type CommitAttempt,
  type LookupAttempt
} from "./classify.js";

/**
 * Default per-attempt timeout (ms), overridable per instance via `timeoutMs`.
 *
 * It MUST exceed the server's lock-wait deadline — `FILE_LOCK_MAX_WAIT_MS =
 * 10_000` in `packages/scad-core/src/store/file-lock.ts` (read on the base
 * commit) — because a legitimate queued writer is only abandoned by the
 * server at that deadline: an adapter that gave up first would report
 * `timeout` (ambiguous) for an attempt the server still grants the lock to
 * and commits. 15s leaves a 5s margin. Both numbers are restated in the PR.
 */
export const EDITOR_CLIENT_TIMEOUT_MS = 15_000;

export interface EditorClientOptions {
  /** The transport: `apps/web/src/lib/apiClient.ts`'s client (only the two seam methods are used). */
  client: Pick<ApiClient, "commitEditorCommand" | "getEditorOperation">;
  /**
   * Criterion 4: invoked whenever this adapter learns a DEFINITE rejection
   * whose frozen error code is `CONFLICT`, so the cache owner can
   * `invalidate()` and re-read. Injected plain callback — this module stays
   * React-free and message-text-free.
   */
  onDefiniteConflict?: (projectId: string) => void;
  /** Per-attempt timeout override (ms). Defaults to {@link EDITOR_CLIENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable timer (the controller's `TimerLike`); defaults to the real one. */
  timer?: TimerLike;
}

export interface DisposableEditorClient extends EditorClient {
  /** Drops every per-operation record. Ids never resolved stay ambiguous and resolve only through the lookup route. */
  dispose(): void;
}

interface OperationRecord {
  projectId: string;
  /** The exact request as first submitted — re-sends pass this same object. */
  request: EditorCommitRequest;
  /** `JSON.stringify(request)` at record creation; any later divergence is a caller bug (R3). */
  serializedBody: string;
  /** Sends started for this id. `sends > 0` when a new send begins means that send is a retry. */
  sends: number;
  /** An ambiguous outcome for this id has been RETURNED to the caller (criterion 3's "ambiguous attempt"). */
  ambiguousReturned: boolean;
  /** At most one background re-send in flight (criterion 7 / Q3). */
  resendInFlight: boolean;
  /**
   * A definite outcome LEARNED but not yet returned (R3: the record is
   * released only when the definite outcome is returned to the caller).
   */
  definite: Extract<CommitOutcome, { kind: "definite" }> | null;
}

const TIMEOUT = Symbol("editor-client-timeout");

export function createEditorClient(options: EditorClientOptions): DisposableEditorClient {
  const { client, onDefiniteConflict } = options;
  const timeoutMs = options.timeoutMs ?? EDITOR_CLIENT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("createEditorClient: timeoutMs must be a positive finite number");
  }
  const timer: TimerLike = options.timer ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
    clearTimeout: (handle) => clearTimeout(handle)
  };
  const records = new Map<string, OperationRecord>();

  function raceTimeout<T>(attempt: Promise<T>): Promise<T | typeof TIMEOUT> {
    return new Promise((resolve) => {
      const handle = timer.setTimeout(() => resolve(TIMEOUT), timeoutMs);
      attempt.then((value) => {
        timer.clearTimeout(handle);
        resolve(value);
      });
    });
  }

  function notifyDefiniteConflict(projectId: string, outcome: Extract<CommitOutcome, { kind: "definite" }>): void {
    const response = outcome.response;
    if (response.state === "definitely_not_committed" && response.error?.error_code === "CONFLICT") {
      try {
        onDefiniteConflict?.(projectId);
      } catch {
        // A cache-invalidation hook failure must never corrupt classification
        // or reject the caller's outcome — the outcome is the contract.
      }
    }
  }

  /** R3: knowledge of a definite answer is recorded once, returned later, released on return. */
  function learn(record: OperationRecord, outcome: Extract<CommitOutcome, { kind: "definite" }>): void {
    if (record.definite) return;
    record.definite = outcome;
    notifyDefiniteConflict(record.projectId, outcome);
  }

  function failureFromError(cause: unknown): AttemptFailure {
    if (cause instanceof ApiClientError) {
      if (cause.kind === "network") return { kind: "network" };
      if (cause.kind === "unparseable-body") return { kind: "unparseable-body" };
      return { kind: "http", status: cause.status ?? 0, apiError: cause.apiError };
    }
    // Unknown rejection below the seam (a bug, not a wire condition):
    // classify conservatively as an unanswered request — ambiguous is always
    // the safe direction (criterion 3).
    return { kind: "network" };
  }

  function sendCommit(record: OperationRecord): Promise<CommitAttempt> {
    return (async () => {
      try {
        return { ok: true, receipt: await client.commitEditorCommand(record.projectId, record.request) };
      } catch (cause) {
        return { ok: false, failure: failureFromError(cause) };
      }
    })();
  }

  /**
   * R4: a settlement that arrives after its attempt's outcome was already
   * reported (or a background re-send's settlement) is stored iff it proves a
   * definite answer — a late 200 receipt replay, or a terminal claim. Any
   * late non-definite settlement is ignored: the id stays ambiguous and
   * resolves through the lookup route. Late classification always uses retry
   * rules, since by then the id has had an ambiguous attempt reported.
   */
  function attachLateSettlement<A>(
    record: OperationRecord | null,
    attempt: Promise<A>,
    classify: (settled: A) => CommitOutcome | LookupOutcome
  ): void {
    void attempt.then((settled) => {
      if (!record || record.definite) return;
      const late = classify(settled);
      if (late.kind === "definite") learn(record, late);
    });
  }

  async function runCommitAttempt(record: OperationRecord, retry: boolean): Promise<CommitOutcome> {
    const attempt = sendCommit(record);
    attachLateSettlement(record, attempt, (settled) =>
      classifyCommitAttempt(settled, { retry: true })
    );
    const winner = await raceTimeout(attempt);
    if (winner === TIMEOUT) {
      record.ambiguousReturned = true;
      return { kind: "ambiguous", cause: "timeout" };
    }
    const outcome = classifyCommitAttempt(winner, { retry });
    if (outcome.kind === "definite") {
      learn(record, outcome);
    } else {
      record.ambiguousReturned = true;
    }
    return outcome;
  }

  /** The criterion-3 re-send: identical bytes, one in flight per id, background. */
  function startResend(record: OperationRecord): void {
    if (record.resendInFlight) return;
    record.resendInFlight = true;
    record.sends += 1;
    const attempt = sendCommit(record);
    // No adapter-side timeout here: "exactly one re-send in flight per id"
    // holds until the transport settles it, and the controller keeps polling
    // the lookup route meanwhile. Settlement is handled like a late one.
    void attempt.then((settled) => {
      record.resendInFlight = false;
      if (record.definite) return;
      const outcome = classifyCommitAttempt(settled, { retry: true });
      if (outcome.kind === "definite") learn(record, outcome);
    });
  }

  async function commit(projectId: string, request: EditorCommitRequest): Promise<CommitOutcome> {
    const serializedBody = JSON.stringify(request);
    let record = records.get(request.operationId);
    if (record) {
      if (record.serializedBody !== serializedBody) {
        // R3: the adapter never changes a recorded request. Different bytes
        // under a used id is a caller programming error, not a wire condition.
        throw new Error(
          `EditorClient: operation id "${request.operationId}" was submitted again with a different request body; a recorded request is re-sent byte-identically or not at all.`
        );
      }
      if (record.definite) {
        const definite = record.definite;
        records.delete(request.operationId);
        return definite;
      }
    } else {
      record = {
        projectId,
        request,
        serializedBody,
        sends: 0,
        ambiguousReturned: false,
        resendInFlight: false,
        definite: null
      };
      records.set(request.operationId, record);
    }
    // R3: any send of a recorded id is classified as a retry — its 4xx can be
    // lock contention for an attempt that will still commit.
    const retry = record.sends > 0;
    record.sends += 1;
    const outcome = await runCommitAttempt(record, retry);
    // R3: the record is released when a definite outcome is RETURNED to the
    // caller (here), not when it is first learned (a stored background answer
    // is released by the call that returns it).
    if (outcome.kind === "definite") records.delete(request.operationId);
    return outcome;
  }

  async function lookupOperation(projectId: string, operationId: string): Promise<LookupOutcome> {
    const record = records.get(operationId) ?? null;
    if (record?.definite) {
      const definite = record.definite;
      // R3: released only now — when the definite outcome is RETURNED.
      records.delete(operationId);
      return definite;
    }
    const attempt = (async (): Promise<LookupAttempt> => {
      try {
        return { ok: true, response: await client.getEditorOperation(projectId, operationId) };
      } catch (cause) {
        return { ok: false, failure: failureFromError(cause) };
      }
    })();
    attachLateSettlement(record, attempt, (settled) =>
      classifyLookupAttempt(settled, { hasAmbiguousCommit: true })
    );
    const winner = await raceTimeout(attempt);
    const settled: LookupAttempt =
      winner === TIMEOUT ? { ok: false, failure: { kind: "timeout" } } : winner;
    const outcome = classifyLookupAttempt(settled, {
      // R2: the `unclaimed`-is-not-definite rule applies only to an id with a
      // recorded ambiguous commit attempt in this adapter instance.
      hasAmbiguousCommit: record?.ambiguousReturned ?? false
    });
    if (outcome.kind === "definite") {
      if (record) {
        learn(record, outcome);
        records.delete(operationId);
      } else {
        notifyDefiniteConflict(projectId, outcome);
      }
      return outcome;
    }
    // Criterion 3: `unclaimed` for an id with an ambiguous commit attempt is
    // not definite — the original POST can still be queued and commit later.
    // Re-send the recorded request byte-identically; while the re-send is
    // unresolved this call reports ambiguous and the controller keeps
    // polling (Q3).
    if (
      record &&
      record.ambiguousReturned &&
      settled.ok &&
      settled.response.state === "definitely_not_committed" &&
      settled.response.reason === "unclaimed"
    ) {
      startResend(record);
    }
    return outcome;
  }

  function dispose(): void {
    records.clear();
  }

  return { commit, lookupOperation, dispose };
}
