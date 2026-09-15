// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { EDITOR_MAX_WIRE_BYTES } from "@scadforge/protocol";
import type { EditorVerifyRequest } from "@scadforge/protocol";
import { createApp } from "../app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider, FAKE_RENDER_FAILED_VALUE, FAKE_STALE_REVISION, FAKE_TIMEOUT_VALUE, FAKE_VALIDATION_FAILED_VALUE } from "../test/fakes.js";

function makeApp() {
  return createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
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
