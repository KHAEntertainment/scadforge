// SPDX-License-Identifier: Apache-2.0
//
// S3-C C1 — classification table test (Issue #134 criterion 7): one row per
// case of criterion 3, plus Tech-Lead rulings R1 (lookup transport failures)
// and R2 (record-less lookups pass through).

import { describe, expect, it } from "vitest";
import type { ApiError, EditorReceipt } from "@scadforge/protocol";
import type { AmbiguousCause, CommitOutcome, LookupOutcome } from "../controller/types.js";
import {
  classifyCommitAttempt,
  classifyLookupAttempt,
  type AttemptFailure,
  type CommitAttempt,
  type LookupAttempt
} from "./classify.js";

const receipt = {
  version: 1,
  projectId: "hinged-box",
  operationId: "12345678-1234-4234-9234-123456789abc",
  requestDigest: "d".repeat(64),
  baseEditorRevision: "a".repeat(64),
  editorRevision: "b".repeat(64),
  snapshotId: "0001",
  values: {},
  sidecarDigest: "c".repeat(64)
} as const satisfies EditorReceipt;

const conflict: ApiError = { error_code: "CONFLICT", message: "stale revision" };
const validationError: ApiError = { error_code: "VALIDATION_FAILED", message: "bad value" };

const failures = {
  network: { kind: "network" } as AttemptFailure,
  timeout: { kind: "timeout" } as AttemptFailure,
  unparseable: { kind: "unparseable-body" } as AttemptFailure,
  conflict409: { kind: "http", status: 409, apiError: conflict } satisfies AttemptFailure,
  rejected422: { kind: "http", status: 422, apiError: validationError } satisfies AttemptFailure,
  server5xx: { kind: "http", status: 503, apiError: { error_code: "INTERNAL_ERROR", message: "boom" } } satisfies AttemptFailure
};

function committed(): CommitOutcome {
  return { kind: "definite", response: { version: 1, state: "committed", receipt } };
}

function rejected(error: ApiError | null): CommitOutcome {
  return {
    kind: "definite",
    response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "rejected", error }
  };
}

function ambiguous(cause: AmbiguousCause): CommitOutcome {
  return { kind: "ambiguous", cause };
}

describe("classifyCommitAttempt — first attempt of an id (Issue #134 criterion 3)", () => {
  const cases: Array<[string, CommitAttempt, CommitOutcome]> = [
    ["200 with a parseable receipt is definite committed", { ok: true, receipt }, committed()],
    [
      "4xx with a parseable ApiError is definite definitely_not_committed, error unchanged",
      { ok: false, failure: failures.conflict409 },
      rejected(conflict)
    ],
    [
      "a second 4xx code classifies the same way (one shared path, no message reading)",
      { ok: false, failure: failures.rejected422 },
      rejected(validationError)
    ],
    ["a network error is ambiguous", { ok: false, failure: failures.network }, ambiguous("network-error")],
    ["a timeout is ambiguous", { ok: false, failure: failures.timeout }, ambiguous("timeout")],
    ["a 5xx is ambiguous", { ok: false, failure: failures.server5xx }, ambiguous("http-5xx")],
    ["an unparseable body is ambiguous", { ok: false, failure: failures.unparseable }, ambiguous("unparseable-body")],
    [
      "a 4xx whose body is NOT a parseable ApiError is ambiguous (unparseable body)",
      { ok: false, failure: failures.unparseable },
      ambiguous("unparseable-body")
    ]
  ];
  it.each(cases)("%s", (_name, attempt, expected) => {
    expect(classifyCommitAttempt(attempt, { retry: false })).toEqual(expected);
  });
});

describe("classifyCommitAttempt — after an ambiguous attempt of that id (retry rules)", () => {
  const cases: Array<[string, CommitAttempt, CommitOutcome]> = [
    ["a 200 receipt is still definite (the server replays the stored receipt)", { ok: true, receipt }, committed()],
    [
      "a 4xx is NOT definite — CONFLICT/409 can be lock contention for an attempt that will commit",
      { ok: false, failure: failures.conflict409 },
      ambiguous("server-unknown")
    ],
    ["a 5xx is ambiguous", { ok: false, failure: failures.server5xx }, ambiguous("http-5xx")],
    ["a network error is ambiguous", { ok: false, failure: failures.network }, ambiguous("network-error")],
    ["a timeout is ambiguous", { ok: false, failure: failures.timeout }, ambiguous("timeout")],
    ["an unparseable body is ambiguous", { ok: false, failure: failures.unparseable }, ambiguous("unparseable-body")]
  ];
  it.each(cases)("%s", (_name, attempt, expected) => {
    expect(classifyCommitAttempt(attempt, { retry: true })).toEqual(expected);
  });
});

describe("classifyLookupAttempt — terminal claims and non-terminal answers (criterion 3)", () => {
  const cases: Array<[string, boolean, LookupAttempt, LookupOutcome]> = [
    [
      "committed is definite for any id",
      false,
      { ok: true, response: { version: 1, state: "committed", receipt } },
      committed()
    ],
    [
      "definitely_not_committed/rejected is definite even after an ambiguous attempt",
      true,
      {
        ok: true,
        response: {
          version: 1,
          state: "definitely_not_committed",
          requestDigest: "d".repeat(64),
          reason: "rejected",
          error: conflict
        }
      },
      {
        kind: "definite",
        // passed through unchanged, requestDigest included
        response: {
          version: 1,
          state: "definitely_not_committed",
          requestDigest: "d".repeat(64),
          reason: "rejected",
          error: conflict
        }
      }
    ],
    [
      "definitely_not_committed/aborted is definite even after an ambiguous attempt",
      true,
      {
        ok: true,
        response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "aborted", error: null }
      },
      {
        kind: "definite",
        response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "aborted", error: null }
      }
    ],
    [
      "unknown is ambiguous and never presented as rejected",
      true,
      { ok: true, response: { version: 1, state: "unknown", requestDigest: null } },
      ambiguous("server-unknown")
    ],
    [
      "unclaimed is NOT definite for an id with a recorded ambiguous commit attempt",
      true,
      {
        ok: true,
        response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null }
      },
      ambiguous("server-unknown")
    ],
    [
      "R2: unclaimed for an id with NO recorded ambiguous commit attempt passes through as definite",
      false,
      {
        ok: true,
        response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null }
      },
      {
        kind: "definite",
        response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null }
      }
    ]
  ];
  it.each(cases)("%s", (_name, hasAmbiguousCommit, attempt, expected) => {
    expect(classifyLookupAttempt(attempt, { hasAmbiguousCommit })).toEqual(expected);
  });
});

describe("classifyLookupAttempt — R1: transport failures of the lookup route are ambiguous whatever the status", () => {
  const cases: Array<[string, LookupAttempt, AmbiguousCause]> = [
    ["a network error", { ok: false, failure: failures.network }, "network-error"],
    ["a timeout", { ok: false, failure: failures.timeout }, "timeout"],
    ["a 5xx", { ok: false, failure: failures.server5xx }, "http-5xx"],
    ["an unparseable body", { ok: false, failure: failures.unparseable }, "unparseable-body"],
    [
      "a 4xx (the lookup takes the same project lock and can itself get 409) — never a rejection of the operation",
      { ok: false, failure: failures.conflict409 },
      "server-unknown"
    ]
  ];
  it.each(cases)("%s", (_name, attempt, cause) => {
    expect(classifyLookupAttempt(attempt, { hasAmbiguousCommit: true })).toEqual({ kind: "ambiguous", cause });
    expect(classifyLookupAttempt(attempt, { hasAmbiguousCommit: false })).toEqual({ kind: "ambiguous", cause });
  });
});
