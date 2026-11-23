// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EDITOR_MAX_WIRE_BYTES } from "@scadforge/protocol";
import type { EditorCommitRequest, EditorFeature, EditorVerifyRequest } from "@scadforge/protocol";
import { createApp } from "../app.js";
import {
  createFakeScadCoreApi,
  createScriptedAgentProvider,
  seedFakeEditorClaim,
  seedFakeEditorFeature,
  FAKE_RENDER_FAILED_VALUE,
  FAKE_STALE_REVISION,
  FAKE_TIMEOUT_VALUE,
  FAKE_VALIDATION_FAILED_VALUE
} from "../test/fakes.js";

function makeApp() {
  return createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
}

/** For tests (B6's editor-command suite) that need direct access to the fake's in-memory state via `_projects` (seeding a feature or a specific claim). */
function makeAppWithFake() {
  const scadCore = createFakeScadCoreApi();
  const app = createApp({ scadCore, agent: createScriptedAgentProvider([]) });
  return { app, scadCore };
}

async function createProject(app: ReturnType<typeof makeApp>): Promise<string> {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bracket" })
  });
  const body = await res.json();
  return body.project.id as string;
}

const HEX64 = "a".repeat(64);
const FEATURE_ID = "11111111-1111-1111-1111-111111111111";

function verifyRequest(overrides: Partial<EditorVerifyRequest> = {}): EditorVerifyRequest {
  return {
    version: 1,
    baseEditorRevision: HEX64,
    command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 15 },
    intent: "edit",
    traversal: null,
    ...overrides
  };
}

async function postVerify(app: ReturnType<typeof makeApp>, projectId: string, request: unknown) {
  return app.request(`/api/projects/${projectId}/editor/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
}

async function getDocument(app: ReturnType<typeof makeApp>, projectId: string) {
  return app.request(`/api/projects/${projectId}/editor`);
}

async function postCommand(app: ReturnType<typeof makeApp>, projectId: string, request: unknown) {
  return app.request(`/api/projects/${projectId}/editor/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
}

async function getOperation(app: ReturnType<typeof makeApp>, projectId: string, operationId: string) {
  return app.request(`/api/projects/${projectId}/editor/operations/${operationId}`);
}

const OPERATION_ID = "22222222-2222-2222-2222-222222222222";
const PROOF_ID = "33333333-3333-3333-3333-333333333333";

function fixtureFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: FEATURE_ID,
    label: "Wall",
    projectId: "irrelevant-to-the-fake",
    createdAtRevision: HEX64,
    sourceFingerprint: HEX64,
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
    ...overrides
  };
}

function commitRequest(overrides: Partial<EditorCommitRequest> = {}): EditorCommitRequest {
  return {
    version: 1,
    baseEditorRevision: HEX64,
    command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 15 },
    intent: "edit",
    traversal: null,
    operationId: OPERATION_ID,
    proofId: PROOF_ID,
    ...overrides
  };
}

describe("POST /api/projects/:projectId/editor/verify", () => {
  it("returns the frozen EditorProofResponse shape on success", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await postVerify(app, id, verifyRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(typeof body.proofId).toBe("string");
    expect(body.commandDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.baseEditorRevision).toBe(HEX64);
    expect(typeof body.expiresAt).toBe("string");
  });

  it("404s (PROJECT_NOT_FOUND) on an unknown project", async () => {
    const app = makeApp();
    const res = await postVerify(app, "nope", verifyRequest());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("400s (INVALID_REQUEST) on an unsafe project id", async () => {
    const app = makeApp();
    const res = await postVerify(app, "..%2Fetc", verifyRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("400s (INVALID_REQUEST) on malformed JSON", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/editor/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("400s (INVALID_REQUEST) when the request fails protocol validation (wrong version)", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await postVerify(app, id, { ...verifyRequest(), version: 2 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("400s (INVALID_REQUEST) when baseEditorRevision is not 64-hex", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await postVerify(app, id, { ...verifyRequest(), baseEditorRevision: "not-hex" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("409s (CONFLICT) on a stale base editor revision", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await postVerify(app, id, verifyRequest({ baseEditorRevision: FAKE_STALE_REVISION }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });
  });

  it("422s (VALIDATION_FAILED) with the refusal reason as the message when the probe refuses", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await postVerify(app, id, verifyRequest({ command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: FAKE_VALIDATION_FAILED_VALUE } }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error_code).toBe("VALIDATION_FAILED");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("500s (RENDER_FAILED) on an engine failure", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await postVerify(app, id, verifyRequest({ command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: FAKE_RENDER_FAILED_VALUE } }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error_code: "RENDER_FAILED" });
  });

  it("504s (TIMEOUT) on an engine timeout", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await postVerify(app, id, verifyRequest({ command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: FAKE_TIMEOUT_VALUE } }));
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error_code: "TIMEOUT" });
  });

  // ── EDITOR_MAX_WIRE_BYTES boundary (correction C5) ─────────────────────
  //
  // Padding is appended OUTSIDE the JSON body: trailing ASCII whitespace at
  // exactly the limit (JSON.parse ignores it, so this remains a genuinely
  // parseable, schema-valid request — proving the limit does not reject a
  // legitimately-sized request), and one non-whitespace byte over the limit
  // (which would ALSO fail JSON.parse if reached) — asserting the specific
  // "exceeds byte limit" message, not just a 400 status, proves the size
  // check ran BEFORE parsing was ever attempted, not that parsing merely
  // also failed for some other reason.

  it("accepts a request at exactly EDITOR_MAX_WIRE_BYTES (not rejected by the global 20 MiB limiter or this route's limit)", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const json = JSON.stringify(verifyRequest());
    const padded = json + " ".repeat(EDITOR_MAX_WIRE_BYTES - Buffer.byteLength(json, "utf8"));
    expect(Buffer.byteLength(padded, "utf8")).toBe(EDITOR_MAX_WIRE_BYTES);

    const res = await app.request(`/api/projects/${id}/editor/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: padded
    });
    expect(res.status).toBe(200);
  });

  it("refuses a body of EDITOR_MAX_WIRE_BYTES + 1 byte BEFORE parsing, with the size-limit message", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const json = JSON.stringify(verifyRequest());
    const padded = json + " ".repeat(EDITOR_MAX_WIRE_BYTES - Buffer.byteLength(json, "utf8")) + "X"; // one byte over, and not valid JSON if reached
    expect(Buffer.byteLength(padded, "utf8")).toBe(EDITOR_MAX_WIRE_BYTES + 1);

    const res = await app.request(`/api/projects/${id}/editor/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: padded
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_code).toBe("INVALID_REQUEST");
    expect(body.message).toMatch(/exceeds/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/projects/:projectId/editor (S3-B ticket B6, Issue #98)
// ═════════════════════════════════════════════════════════════════════════

describe("GET /api/projects/:projectId/editor", () => {
  it("returns the frozen EditorDocument shape", async () => {
    const { app } = makeAppWithFake();
    const id = await createProject(app);
    const res = await getDocument(app, id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.projectId).toBe(id);
    expect(body.sidecarStatus).toBe("ready");
    expect(body.sidecar).toEqual({ version: 1, features: [] });
    expect(Array.isArray(body.eligibility)).toBe(true);
  });

  it("reflects a feature added by an earlier command", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature());
    const res = await getDocument(app, id);
    const body = await res.json();
    expect(body.sidecar.features).toHaveLength(1);
    expect(body.sidecar.features[0].featureId).toBe(FEATURE_ID);
  });

  it("404s (PROJECT_NOT_FOUND) on an unknown project", async () => {
    const { app } = makeAppWithFake();
    const res = await getDocument(app, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("400s (INVALID_REQUEST) on an unsafe project id", async () => {
    const { app } = makeAppWithFake();
    const res = await getDocument(app, "..%2Fetc");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/projects/:projectId/editor/commands (S3-B ticket B6, Issue #98)
// ═════════════════════════════════════════════════════════════════════════

describe("POST /api/projects/:projectId/editor/commands", () => {
  it("accepts a set-value command and returns the frozen EditorReceipt shape", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);

    const res = await postCommand(app, id, commitRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.projectId).toBe(id);
    expect(body.operationId).toBe(OPERATION_ID);
    expect(body.values).toEqual({ wall: 15 });
    expect(typeof body.snapshotId).toBe("string");
    expect(body.sidecarDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replaying the identical request for a committed operation id returns the SAME receipt (idempotent)", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);

    const first = await postCommand(app, id, commitRequest());
    const firstBody = await first.json();
    const second = await postCommand(app, id, commitRequest());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
  });

  it("409s (CONFLICT) when a different request reuses an already-reserved operation id", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);

    await postCommand(app, id, commitRequest());
    const res = await postCommand(app, id, commitRequest({ command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 99 } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });
  });

  it("replaying a rejected operation id returns the ORIGINAL stored error and status", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);

    const noOp = commitRequest({ command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 2 } }); // equals current value -- no-op
    const first = await postCommand(app, id, noOp);
    expect(first.status).toBe(422);
    const firstBody = await first.json();

    const second = await postCommand(app, id, noOp);
    expect(second.status).toBe(422);
    expect(await second.json()).toEqual(firstBody);
  });

  it("422s (VALIDATION_FAILED) on a no-op set-value", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);

    const res = await postCommand(app, id, commitRequest({ command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 2 } }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error_code).toBe("VALIDATION_FAILED");
    expect(body.message).toMatch(/no-op/i);
  });

  it("422s (VALIDATION_FAILED) when no feature exists at that binding version", async () => {
    const { app } = makeAppWithFake();
    const id = await createProject(app);
    const res = await postCommand(app, id, commitRequest());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error_code: "VALIDATION_FAILED" });
  });

  it("409s (CONFLICT) on a stale base editor revision", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);
    const res = await postCommand(app, id, commitRequest({ baseEditorRevision: FAKE_STALE_REVISION }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });
  });

  it("409s (CONFLICT), with the exact spec message, replaying an aborted operation id", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);

    const request = commitRequest();
    await postCommand(app, id, request); // commits normally first
    // Force the SAME claim to `aborted`, preserving its digest, to simulate
    // "recovery marked this aborted" without needing a real crash.
    const project = scadCore._projects.get(id)!;
    const existingDigest = project.editorClaims.get(OPERATION_ID)!.digest;
    seedFakeEditorClaim(scadCore, id, OPERATION_ID, { digest: existingDigest, terminal: { kind: "aborted" } });

    const res = await postCommand(app, id, request);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error_code).toBe("CONFLICT");
    expect(body.message).toBe("Operation was aborted before commit; refresh and submit a new operation.");
  });

  it("undoes a set-value: restores the before value given the exact derived inverse", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);
    await postCommand(app, id, commitRequest()); // wall: 2 -> 15, committed under OPERATION_ID

    const undoId = "44444444-4444-4444-4444-444444444444";
    const res = await postCommand(
      app,
      id,
      commitRequest({
        operationId: undoId,
        intent: "undo",
        traversal: { operationId: OPERATION_ID, direction: "undo" },
        command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 2 }
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.values).toEqual({ wall: 2 });
  });

  it("422s (VALIDATION_FAILED) when the submitted traversal command does not match the exact derived inverse", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);
    await postCommand(app, id, commitRequest());

    const undoId = "44444444-4444-4444-4444-444444444444";
    const res = await postCommand(
      app,
      id,
      commitRequest({
        operationId: undoId,
        intent: "undo",
        traversal: { operationId: OPERATION_ID, direction: "undo" },
        command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 999 } // wrong -- not the derived inverse
      })
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error_code: "VALIDATION_FAILED" });
  });

  it("409s (CONFLICT) undoing a traversal that references a non-traversable (never-committed) operation id", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);

    const undoId = "44444444-4444-4444-4444-444444444444";
    const neverCommittedId = "55555555-5555-5555-5555-555555555555";
    const res = await postCommand(
      app,
      id,
      commitRequest({
        operationId: undoId,
        intent: "undo",
        traversal: { operationId: neverCommittedId, direction: "undo" },
        command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 2 }
      })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });
  });

  it("404s (PROJECT_NOT_FOUND) on an unknown project", async () => {
    const { app } = makeAppWithFake();
    const res = await postCommand(app, "nope", commitRequest());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("400s (INVALID_REQUEST) on an unsafe project id", async () => {
    const { app } = makeAppWithFake();
    const res = await postCommand(app, "..%2Fetc", commitRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("400s (INVALID_REQUEST) on malformed JSON, reserving nothing", async () => {
    const { app } = makeAppWithFake();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/editor/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });

    // Nothing was reserved -- looking up the operation id it WOULD have used is unclaimed.
    const looked = await getOperation(app, id, OPERATION_ID);
    expect(await looked.json()).toMatchObject({ state: "definitely_not_committed", reason: "unclaimed" });
  });

  it("refuses a body of EDITOR_MAX_WIRE_BYTES + 1 byte BEFORE parsing", async () => {
    const { app } = makeAppWithFake();
    const id = await createProject(app);
    const json = JSON.stringify(commitRequest());
    const padded = json + " ".repeat(EDITOR_MAX_WIRE_BYTES - Buffer.byteLength(json, "utf8")) + "X";
    const res = await app.request(`/api/projects/${id}/editor/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: padded
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_code).toBe("INVALID_REQUEST");
    expect(body.message).toMatch(/exceeds/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/projects/:projectId/editor/operations/:operationId (S3-B ticket B6, Issue #98)
// ═════════════════════════════════════════════════════════════════════════

describe("GET /api/projects/:projectId/editor/operations/:operationId", () => {
  it("returns definitely_not_committed/unclaimed for an id never reserved", async () => {
    const { app } = makeAppWithFake();
    const id = await createProject(app);
    const res = await getOperation(app, id, OPERATION_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 1, state: "definitely_not_committed", reason: "unclaimed", error: null });
  });

  it("returns committed with the receipt for a committed operation id", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);
    const commit = await postCommand(app, id, commitRequest());
    const receipt = await commit.json();

    const res = await getOperation(app, id, OPERATION_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, state: "committed", receipt });
  });

  it("returns definitely_not_committed/rejected with the original error for a rejected operation id", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorFeature(scadCore, id, fixtureFeature(), 2);
    const noOp = commitRequest({ command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 2 } });
    const rejected = await postCommand(app, id, noOp);
    const rejectedBody = await rejected.json();

    const res = await getOperation(app, id, OPERATION_ID);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ version: 1, state: "definitely_not_committed", reason: "rejected" });
    expect(body.error).toEqual(rejectedBody);
  });

  it("returns definitely_not_committed/aborted for an aborted operation id", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorClaim(scadCore, id, OPERATION_ID, { digest: "any-digest", terminal: { kind: "aborted" } });

    const res = await getOperation(app, id, OPERATION_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 1, state: "definitely_not_committed", reason: "aborted", error: null });
  });

  it("returns unknown for a claim seeded as still pending (no transaction) -- one of the three wire states, never a permanent pending", async () => {
    const { app, scadCore } = makeAppWithFake();
    const id = await createProject(app);
    seedFakeEditorClaim(scadCore, id, OPERATION_ID, { digest: "any-digest", terminal: null });

    const res = await getOperation(app, id, OPERATION_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 1, state: "unknown" });
  });

  it("400s (INVALID_REQUEST) on an invalid (non-UUID) operation id", async () => {
    const { app } = makeAppWithFake();
    const id = await createProject(app);
    const res = await getOperation(app, id, "not-a-uuid");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("404s (PROJECT_NOT_FOUND) on an unknown project", async () => {
    const { app } = makeAppWithFake();
    const res = await getOperation(app, "nope", OPERATION_ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });
});
