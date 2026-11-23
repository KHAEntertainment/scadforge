// SPDX-License-Identifier: Apache-2.0
//
// S3-C C1 — seam adapter tests (Issue #134 criteria 3, 4, 7 and Tech-Lead
// rulings R1–R4). The adapter under test is REAL; beneath it the real
// `apiClient` runs against a scripted `fetch` (no second fake editor client —
// criterion 8). Criterion 7's "real-server versions are C5's" note applies:
// these prove the client logic with a scripted `fetch`.

import { describe, expect, it, vi } from "vitest";
import type { EditorCommitRequest, EditorReceipt } from "@scadforge/protocol";
import { createApiClient } from "../../../lib/apiClient.js";
import { createEditorClient, EDITOR_CLIENT_TIMEOUT_MS } from "./editorClient.js";

// ── fixtures ───────────────────────────────────────────────────────────────

const OP_ID = "12345678-1234-4234-9234-123456789abc";
const PROOF_ID = "12345678-1234-4234-9234-123456789abd";
const FEATURE_ID = "12345678-1234-4234-9234-123456789abe";
const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);

function commitRequest(operationId = OP_ID): EditorCommitRequest {
  return {
    version: 1,
    baseEditorRevision: REV_A,
    command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 10 },
    intent: "edit",
    traversal: null,
    operationId,
    proofId: PROOF_ID
  };
}

function receiptBody(operationId = OP_ID): EditorReceipt {
  return {
    version: 1,
    projectId: "hinged-box",
    operationId,
    requestDigest: "d".repeat(64),
    baseEditorRevision: REV_A,
    editorRevision: REV_B,
    snapshotId: "0001",
    values: {},
    sidecarDigest: "c".repeat(64)
  };
}

function opCommitted(operationId = OP_ID) {
  return { version: 1, state: "committed", receipt: receiptBody(operationId) };
}
function opUnclaimed() {
  return { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null };
}
function opUnknown() {
  return { version: 1, state: "unknown", requestDigest: null };
}
function opRejected(message = "rejected") {
  return {
    version: 1,
    state: "definitely_not_committed",
    requestDigest: "d".repeat(64),
    reason: "rejected",
    error: { error_code: "VALIDATION_FAILED", message }
  };
}

// ── scripted fetch harness (real apiClient over a scripted fetch) ──────────

type Step =
  | { kind: "response"; make: () => Response }
  | { kind: "throw"; error: unknown }
  | { kind: "deferred" };

interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
}

function json(body: unknown, status = 200): Step {
  return {
    kind: "response",
    make: () => rawJson(body, status)
  };
}

function rawJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeApi(steps: Step[]) {
  const calls: RecordedCall[] = [];
  const deferreds: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected fetch: ${method} ${url}`);
    if (step.kind === "throw") throw step.error;
    if (step.kind === "deferred") {
      return new Promise<Response>((resolve, reject) => deferreds.push({ resolve, reject }));
    }
    return step.make();
  });
  const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  return { client, calls, deferreds };
}

/** Let every pending microtask (and one macrotask boundary) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── criterion 7, edge case 1 ───────────────────────────────────────────────

describe("edge case 1: ambiguous POST, lookup unclaimed, identical re-send returns 200", () => {
  it("yields committed, exactly one operation id, and byte-identical request bodies", async () => {
    const { client, calls } = makeApi([
      { kind: "throw", error: new TypeError("Failed to fetch") }, // POST #1 — network error
      json(opUnclaimed()), // GET — unclaimed
      json(receiptBody()) // POST #2 — the re-send replays/commits
    ]);
    const adapter = createEditorClient({ client });
    const request = commitRequest();

    const first = await adapter.commit("hinged-box", request);
    expect(first).toEqual({ kind: "ambiguous", cause: "network-error" });

    const duringResend = await adapter.lookupOperation("hinged-box", OP_ID);
    // Q3: the call reports ambiguous while the re-send is unresolved.
    expect(duringResend.kind).toBe("ambiguous");

    await flush(); // the background re-send lands its 200 receipt (stored)

    const final = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(final.kind).toBe("definite");
    expect(final).toMatchObject({ response: { state: "committed", receipt: receiptBody() } });

    // Exactly two POSTs and one GET; the third call is the re-send.
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    // Criterion 7: byte-identical request bodies across attempts…
    expect(calls[0].body).toBe(calls[2].body);
    // …and exactly one operation id, the one C2 minted (the adapter never mints).
    const sentBodies = [JSON.parse(calls[0].body ?? ""), JSON.parse(calls[2].body ?? "")];
    expect(sentBodies[0].operationId).toBe(OP_ID);
    expect(sentBodies[1].operationId).toBe(OP_ID);
  });
});

// ── criterion 7, edge case 2 ───────────────────────────────────────────────

describe("edge case 2: a retry 409 after an ambiguous POST is NOT definite", () => {
  it("re-send path: lookup unclaimed, re-send gets 409 — stays ambiguous; a later lookup committed is definite", async () => {
    const { client, calls } = makeApi([
      { kind: "throw", error: new TypeError("Failed to fetch") }, // POST #1
      json(opUnclaimed()), // GET #1
      json({ error_code: "CONFLICT", message: "lock wait deadline exceeded" }, 409), // POST #2 — re-send refused
      json(opCommitted()) // GET #2 — the original attempt committed
    ]);
    const adapter = createEditorClient({ client });

    await adapter.commit("hinged-box", commitRequest());
    const afterResend = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(afterResend.kind).toBe("ambiguous"); // the 409 changed nothing
    await flush();

    const final = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(final).toMatchObject({ kind: "definite", response: { state: "committed" } });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST", "GET"]);
  });

  it("direct retry path: a second commit() for the same id getting 409 stays ambiguous", async () => {
    const { client } = makeApi([
      { kind: "throw", error: new TypeError("Failed to fetch") }, // POST #1 — ambiguous
      json({ error_code: "CONFLICT", message: "stale revision" }, 409) // POST #2 — retry refused
    ]);
    const adapter = createEditorClient({ client });
    const request = commitRequest();

    expect(await adapter.commit("hinged-box", request)).toEqual({ kind: "ambiguous", cause: "network-error" });
    const retry = await adapter.commit("hinged-box", request);
    expect(retry.kind).toBe("ambiguous");
    expect(retry).toEqual({ kind: "ambiguous", cause: "server-unknown" });
  });
});

// ── criterion 7, edge case 3 ───────────────────────────────────────────────

describe("edge case 3: unknown is never rejected; only the terminal claim is", () => {
  it("three unknown lookups stay ambiguous, then a rejected claim is definite", async () => {
    const { client } = makeApi([
      json({ error_code: "INTERNAL_ERROR", message: "boom" }, 503), // POST — ambiguous
      json(opUnknown()),
      json(opUnknown()),
      json(opUnknown()),
      json(opRejected("validation failed"))
    ]);
    const adapter = createEditorClient({ client });

    await adapter.commit("hinged-box", commitRequest());
    for (let i = 0; i < 3; i += 1) {
      const outcome = await adapter.lookupOperation("hinged-box", OP_ID);
      expect(outcome).toEqual({ kind: "ambiguous", cause: "server-unknown" });
    }
    const terminal = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(terminal).toMatchObject({
      kind: "definite",
      response: { state: "definitely_not_committed", reason: "rejected" }
    });
  });
});

// ── criterion 7, edge case 4 and criterion 4 ───────────────────────────────

describe("edge case 4: first-attempt 409 is definite and invalidates the cache", () => {
  it("returns definitely_not_committed with the ApiError unchanged and fires the CONFLICT hook", async () => {
    const { client } = makeApi([json({ error_code: "CONFLICT", message: "stale revision" }, 409)]);
    const onDefiniteConflict = vi.fn();
    const adapter = createEditorClient({ client, onDefiniteConflict });

    const outcome = await adapter.commit("hinged-box", commitRequest());
    expect(outcome).toEqual({
      kind: "definite",
      response: {
        version: 1,
        state: "definitely_not_committed",
        requestDigest: null,
        reason: "rejected",
        error: { error_code: "CONFLICT", message: "stale revision" }
      }
    });
    expect(onDefiniteConflict).toHaveBeenCalledTimes(1);
    expect(onDefiniteConflict).toHaveBeenCalledWith("hinged-box");
  });
});

// ── criterion 7, edge case 5 (criterion 4: no prose parsing) ───────────────

describe("edge case 5: CONFLICT message text never steers classification", () => {
  it("two different CONFLICT messages take the identical path", async () => {
    for (const message of ["stale revision", "lock wait deadline exceeded while acquiring params lock"]) {
      const { client } = makeApi([json({ error_code: "CONFLICT", message }, 409)]);
      const onDefiniteConflict = vi.fn();
      const adapter = createEditorClient({ client, onDefiniteConflict });
      const outcome = await adapter.commit("hinged-box", commitRequest());
      expect(outcome).toMatchObject({
        kind: "definite",
        response: { state: "definitely_not_committed", reason: "rejected", error: { error_code: "CONFLICT", message } }
      });
      expect(onDefiniteConflict).toHaveBeenCalledTimes(1);
      expect(onDefiniteConflict).toHaveBeenCalledWith("hinged-box");
    }
  });
});

// ── criterion 7, edge case 7 + ruling R3 ───────────────────────────────────

describe("edge case 7 / R3: the adapter never mints or changes ids or requests", () => {
  it("rejects a re-submission of the same id with different bytes as a programming error, without sending", async () => {
    const { client, calls } = makeApi([]);
    const adapter = createEditorClient({ client });
    await adapter.commit("hinged-box", commitRequest()).catch(() => undefined); // no steps → fetch throws
    calls.length = 0;

    const different = commitRequest();
    different.command = { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 99 };
    await expect(adapter.commit("hinged-box", different)).rejects.toThrow(/different request body/);
    expect(calls).toHaveLength(0);
  });

  it("re-sends identical bytes for a repeated id and classifies the send as a retry", async () => {
    const { client, calls } = makeApi([
      { kind: "throw", error: new TypeError("Failed to fetch") }, // POST #1 — ambiguous
      json({ error_code: "CONFLICT", message: "stale revision" }, 409) // POST #2 — identical retry refused
    ]);
    const adapter = createEditorClient({ client });
    const request = commitRequest();

    await adapter.commit("hinged-box", request);
    const retry = await adapter.commit("hinged-box", request);
    expect(retry.kind).toBe("ambiguous"); // retry rules: 4xx is never definite
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toBe(calls[1].body);
  });

  it("R3: releases the record when a definite outcome is RETURNED — a later lookup consults the route again (R2 pass-through)", async () => {
    const { client, calls } = makeApi([json(receiptBody()), json(opUnclaimed())]);
    const adapter = createEditorClient({ client });

    const first = await adapter.commit("hinged-box", commitRequest());
    expect(first.kind).toBe("definite"); // returned → the record is released now

    // A later lookup for the settled id is record-less: the server's answer
    // passes through (R2) instead of replaying a stored one.
    const later = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(later).toMatchObject({
      kind: "definite",
      response: { state: "definitely_not_committed", reason: "unclaimed" }
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
});

// ── ruling R1 at the seam: lookup transport failures ───────────────────────

describe("R1: a lookup route 4xx is ambiguous and never a rejection of the operation", () => {
  it("classifies a lookup 409 CONFLICT as ambiguous (the lookup can hit the same lock)", async () => {
    const { client } = makeApi([json({ error_code: "CONFLICT", message: "lock wait deadline exceeded" }, 409)]);
    const adapter = createEditorClient({ client });

    const outcome = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(outcome).toEqual({ kind: "ambiguous", cause: "server-unknown" });
  });
});

// ── ruling R2: lookups for ids with no record pass through ─────────────────

describe("R2: an id with no record passes the server's parsed answer through", () => {
  it("unclaimed is definite when there is no recorded ambiguous commit attempt", async () => {
    const { client } = makeApi([json(opUnclaimed())]);
    const adapter = createEditorClient({ client });

    const outcome = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(outcome).toEqual({
      kind: "definite",
      response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null }
    });
  });
});

// ── ruling R4: timeout, and the late settlement of a timed-out attempt ─────

describe("R4: timeout is ambiguous; a late 200 receipt is stored as definite committed", () => {
  it("reports timeout, then stores the late receipt so the next lookup answers committed without a fetch", async () => {
    // The fetch is manually controlled and never settles on its own, so any
    // short timeout deterministically wins the race.
    const { client, calls, deferreds } = makeApi([{ kind: "deferred" }]);
    const adapter = createEditorClient({ client, timeoutMs: 5 });

    const outcome = await adapter.commit("hinged-box", commitRequest());
    expect(outcome).toEqual({ kind: "ambiguous", cause: "timeout" });
    expect(calls).toHaveLength(1);

    // The original fetch settles LATE with a 200 receipt → stored (R4).
    deferreds[0].resolve(
      new Response(JSON.stringify(receiptBody()), { status: 200, headers: { "content-type": "application/json" } })
    );
    await flush();

    const final = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(final).toMatchObject({ kind: "definite", response: { state: "committed", receipt: receiptBody() } });
    // Stored answer — the lookup route was not consulted again.
    expect(calls).toHaveLength(1);
  });

  it("ignores any late non-200 settlement: the id stays ambiguous and resolves through lookup", async () => {
    const { client, calls, deferreds } = makeApi([{ kind: "deferred" }, json(opCommitted())]);
    const adapter = createEditorClient({ client, timeoutMs: 5 });

    expect(await adapter.commit("hinged-box", commitRequest())).toEqual({ kind: "ambiguous", cause: "timeout" });

    // A late 4xx is NOT a definite answer (criterion 3: after an ambiguous
    // attempt only a 200 receipt or a terminal claim is definite).
    deferreds[0].resolve(
      new Response(JSON.stringify({ error_code: "CONFLICT", message: "stale revision" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      })
    );
    await flush();

    const final = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(final).toMatchObject({ kind: "definite", response: { state: "committed" } });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
});

// ── sanity: the named timeout constant beats the server's lock deadline ────

describe("EDITOR_CLIENT_TIMEOUT_MS (R4)", () => {
  it("is longer than the server's 10s lock-wait deadline (FILE_LOCK_MAX_WAIT_MS)", () => {
    expect(EDITOR_CLIENT_TIMEOUT_MS).toBeGreaterThan(10_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix batch 1 (PR #138 review): F1–F5
// ═══════════════════════════════════════════════════════════════════════════

describe("F1: the re-send is byte-identical even if the caller mutates its request object", () => {
  it("sends the recorded snapshot: identical body string, original URL, original id and nested fields", async () => {
    const { client, calls } = makeApi([
      { kind: "throw", error: new TypeError("Failed to fetch") }, // POST #1 — ambiguous
      json(opUnclaimed()), // GET — unclaimed → triggers the re-send
      json(receiptBody()) // POST #2 — the re-send
    ]);
    const adapter = createEditorClient({ client });
    const request = commitRequest();

    expect(await adapter.commit("hinged-box", request)).toEqual({ kind: "ambiguous", cause: "network-error" });

    // Mutate the ORIGINAL object after the first answer and before the
    // re-send: a nested command field, proofId and operationId all change.
    request.command = { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 999 };
    request.proofId = "12345678-1234-4234-9234-123456789aaa";
    request.operationId = "12345678-1234-4234-9234-123456789fff";

    await adapter.lookupOperation("hinged-box", OP_ID); // triggers the re-send
    await flush();

    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    expect(calls[2].body).toBe(calls[0].body); // byte-identical body string
    expect(calls[2].url).toBe(calls[0].url); // original route
    const resent = JSON.parse(calls[2].body ?? "") as { operationId: string; proofId: string; command: { value: number } };
    expect(resent.operationId).toBe(OP_ID); // original id
    expect(resent.proofId).toBe(PROOF_ID); // original proofId
    expect(resent.command.value).toBe(10); // original nested field
  });
});

describe("F2: overlapping commit() calls for one id never report a false definite rejection", () => {
  it("first settles 409 while the second is unresolved → ambiguous (no CONFLICT hook); second settles 200 → committed", async () => {
    const { client, calls, deferreds } = makeApi([{ kind: "deferred" }, { kind: "deferred" }]);
    const onDefiniteConflict = vi.fn();
    const adapter = createEditorClient({ client, onDefiniteConflict });
    const request = commitRequest();

    const first = adapter.commit("hinged-box", request);
    const second = adapter.commit("hinged-box", request); // identical body → same record, second send
    expect(calls).toHaveLength(2); // two overlapping sends of one id

    // First send hits the pre-claim lock-wait 409 while the second can still commit.
    deferreds[0].resolve(rawJson({ error_code: "CONFLICT", message: "lock wait deadline exceeded" }, 409));
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe("ambiguous"); // never definitely_not_committed
    expect(firstOutcome).toEqual({ kind: "ambiguous", cause: "server-unknown" });
    expect(onDefiniteConflict).not.toHaveBeenCalled();

    // Second send commits.
    deferreds[1].resolve(rawJson(receiptBody()));
    await expect(second).resolves.toMatchObject({ kind: "definite", response: { state: "committed" } });
    expect(onDefiniteConflict).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });
});

describe("F3: dispose() stops late work", () => {
  it("a lookup that resolves unclaimed after dispose() starts no POST and fires no callback", async () => {
    const { client, calls, deferreds } = makeApi([
      { kind: "throw", error: new TypeError("Failed to fetch") }, // POST #1 — ambiguous
      { kind: "deferred" } // GET — resolved only after dispose()
    ]);
    const onDefiniteConflict = vi.fn();
    const adapter = createEditorClient({ client, onDefiniteConflict });

    await adapter.commit("hinged-box", commitRequest());
    const lookup = adapter.lookupOperation("hinged-box", OP_ID);
    adapter.dispose();

    deferreds[0].resolve(rawJson(opUnclaimed())); // would trigger the re-send on a live adapter
    await expect(lookup).resolves.toEqual({ kind: "ambiguous", cause: "server-unknown" });
    await flush();

    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]); // no re-send POST after dispose
    expect(onDefiniteConflict).not.toHaveBeenCalled();
  });
});

describe("F4: records are project-scoped", () => {
  it("a stored receipt for project A is not returned by lookupOperation for project B", async () => {
    const { client, calls, deferreds } = makeApi([
      { kind: "deferred" }, // POST for proj-a (times out, then lands late)
      json(opUnclaimed()) // GET for proj-b
    ]);
    const adapter = createEditorClient({ client, timeoutMs: 5 });

    expect(await adapter.commit("proj-a", commitRequest())).toEqual({ kind: "ambiguous", cause: "timeout" });
    // The late 200 receipt is stored on proj-a's record (R4).
    deferreds[0].resolve(rawJson(receiptBody()));
    await flush();

    // The same operation id under proj-b must not share proj-a's record.
    const outcome = await adapter.lookupOperation("proj-b", OP_ID);
    expect(outcome).toEqual({
      kind: "definite",
      response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null }
    });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]); // proj-b consulted the lookup route
  });
});

describe("F5: a non-200 2xx never yields a definite outcome", () => {
  it("a parseable 201 from the lookup route is ambiguous", async () => {
    const { client } = makeApi([{ kind: "response", make: () => rawJson(opUnknown(), 201) }]);
    const adapter = createEditorClient({ client });

    const outcome = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(outcome).toEqual({ kind: "ambiguous", cause: "unparseable-body" });
  });

  it("a late 201 from the commit route is not stored as committed", async () => {
    const { client, calls, deferreds } = makeApi([{ kind: "deferred" }, json(opCommitted())]);
    const adapter = createEditorClient({ client, timeoutMs: 5 });

    expect(await adapter.commit("hinged-box", commitRequest())).toEqual({ kind: "ambiguous", cause: "timeout" });
    deferreds[0].resolve(rawJson(receiptBody(), 201)); // parseable receipt, wrong status
    await flush();

    // The 201 was not stored: the lookup route is consulted (GET happens).
    const outcome = await adapter.lookupOperation("hinged-box", OP_ID);
    expect(outcome).toMatchObject({ kind: "definite", response: { state: "committed" } });
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });
});
