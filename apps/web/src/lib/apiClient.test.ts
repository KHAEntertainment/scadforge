// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "@scadforge/protocol";
import { ApiClientError, createApiClient } from "./apiClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("apiClient request()", () => {
  it("counterexample: a 200 with a non-JSON body (e.g. Vite's index.html fallback) throws a typed ApiClientError, never a silent null", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<!doctype html><html><body>ScadForge</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
    );
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listProjects()).rejects.toBeInstanceOf(ApiClientError);
    await expect(client.listProjects()).rejects.toMatchObject({
      error_code: "INTERNAL_ERROR"
    });
  });

  it("counterexample: an unreachable server (fetch rejects) surfaces a readable connection error, not a downstream destructuring crash", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const failure = client.listProjects();
    await expect(failure).rejects.toBeInstanceOf(ApiClientError);
    await expect(failure).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });
    await expect(failure).rejects.toThrow(/could not reach/i);
  });

  it("parses a well-formed success body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ projects: [] }));
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listProjects()).resolves.toEqual({ projects: [] });
  });

  it("throws the server's typed error body on a non-2xx JSON response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error_code: "PROJECT_NOT_FOUND", message: "no such project" }, 404)
    );
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.getProject("missing")).rejects.toMatchObject({
      error_code: "PROJECT_NOT_FOUND",
      message: "no such project"
    });
  });

  it("falls back to INTERNAL_ERROR with the status code when a non-2xx response has no JSON body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listProjects()).rejects.toMatchObject({
      error_code: "INTERNAL_ERROR",
      message: expect.stringContaining("500")
    });
  });

  it("treats an empty 200 body as a successful null/undefined body rather than a parse failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listProjects()).resolves.toBeNull();
  });
});

describe("apiClient snapshots (Issue #34)", () => {
  it("getSnapshotDiff hits the frozen diff route and returns the parsed body verbatim, including the first-snapshot empty string", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("/api/projects/p1/snapshots/0001/diff");
      return jsonResponse({ id: "0001", parent: null, diff: "" });
    });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.getSnapshotDiff("p1", "0001")).resolves.toEqual({ id: "0001", parent: null, diff: "" });
  });

  it("revertSnapshot POSTs to the frozen revert route with a JSON body", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("/api/projects/p1/snapshots/0001/revert");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({});
      return jsonResponse({
        snapshot: {
          id: "0002",
          parent: "0001",
          timestamp: "2026-08-27T00:00:00.000Z",
          message: "Revert to 0001",
          origin: "revert",
          pass: null,
          files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: "diff.patch" },
          params: {},
          renders: [],
          validation: null,
          annotations: []
        },
        scad: "// reverted"
      });
    });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.revertSnapshot("p1", "0001");
    expect(result.snapshot.id).toBe("0002");
    expect(result.snapshot.origin).toBe("revert");
  });

  it("counterexample: revertSnapshot surfaces a 409 CONFLICT as a typed ApiClientError, never a silent success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error_code: "CONFLICT", message: "could not allocate a snapshot id" }, 409)
    );
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.revertSnapshot("p1", "0001")).rejects.toMatchObject({
      error_code: "CONFLICT",
      message: "could not allocate a snapshot id"
    });
  });
});

describe("apiClient params methods (Issue #33)", () => {
  it("GET params returns the frozen ParamsResponse shape", async () => {
    const body = { title: "bracket", parameters: [{ name: "wall", type: "number", initial: 4, min: 2, max: 10 }], values: { wall: 4 } };
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.getParams("p1")).resolves.toEqual(body);
    expect(fetchImpl).toHaveBeenCalledWith("/api/projects/p1/params", expect.anything());
  });

  it("PUT params sends the values body and returns the merged ParamsResponse", async () => {
    const responseBody = { title: "bracket", parameters: [], values: { wall: 9 } };
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("/api/projects/p1/params");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ values: { wall: 9 } });
      return jsonResponse(responseBody);
    });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.updateParams("p1", { values: { wall: 9 } })).resolves.toEqual(responseBody);
  });

  it("counterexample: a rejected value surfaces VALIDATION_FAILED with the server's message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error_code: "VALIDATION_FAILED", message: "'wall' value 99 is above its max of 10." }, 422)
    );
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.updateParams("p1", { values: { wall: 99 } })).rejects.toMatchObject({
      error_code: "VALIDATION_FAILED",
      message: expect.stringContaining("above its max")
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Editor methods (S3-C C1, Issue #134 criterion 1): strict parsing on every
// response, frozen error codes surfaced as ApiClientError, and the commit
// route's 200 parsed as a BARE EditorReceipt.
// ─────────────────────────────────────────────────────────────────────────────

const HEX64 = "a".repeat(64);
const SHA64 = "b".repeat(64);
const UUID = "12345678-1234-4234-9234-123456789abc";
const PROOF_UUID = "12345678-1234-4234-9234-123456789abd";
const FEATURE_UUID = "12345678-1234-4234-9234-123456789abe";

function editorDocumentBody() {
  return {
    version: 1,
    projectId: "hinged-box",
    head: null,
    sourceRevision: HEX64,
    sourceFingerprint: HEX64,
    editorRevision: HEX64,
    scad: "cube(10);",
    parameters: [],
    values: {},
    sidecar: { version: 1, features: [] },
    sidecarStatus: "ready",
    eligibility: []
  };
}

function editorProofBody() {
  return {
    version: 1,
    proofId: PROOF_UUID,
    commandDigest: SHA64,
    baseEditorRevision: HEX64,
    expiresAt: "2026-11-23T00:00:00.000Z"
  };
}

function editorReceiptBody() {
  return {
    version: 1,
    projectId: "hinged-box",
    operationId: UUID,
    requestDigest: SHA64,
    baseEditorRevision: HEX64,
    editorRevision: HEX64,
    snapshotId: "0001",
    values: {},
    sidecarDigest: SHA64
  };
}

function editorVerifyRequestBody() {
  return {
    version: 1,
    baseEditorRevision: HEX64,
    command: { kind: "set-value", featureId: FEATURE_UUID, bindingVersion: 1, value: 10 },
    intent: "edit",
    traversal: null
  } as const;
}

function editorCommitRequestBody() {
  return { ...editorVerifyRequestBody(), operationId: UUID, proofId: PROOF_UUID } as const;
}

interface EditorMethodCase {
  name: string;
  call: (client: ReturnType<typeof createApiClient>) => Promise<unknown>;
  url: string;
  method: string;
  successBody: unknown;
}

const EDITOR_METHOD_CASES: EditorMethodCase[] = [
  {
    name: "getEditorDocument",
    call: (client) => client.getEditorDocument("hinged-box"),
    url: "/api/projects/hinged-box/editor",
    method: "GET",
    successBody: editorDocumentBody()
  },
  {
    name: "verifyEditorCommand",
    call: (client) => client.verifyEditorCommand("hinged-box", editorVerifyRequestBody()),
    url: "/api/projects/hinged-box/editor/verify",
    method: "POST",
    successBody: editorProofBody()
  },
  {
    name: "commitEditorCommand",
    call: (client) => client.commitEditorCommand("hinged-box", editorCommitRequestBody()),
    url: "/api/projects/hinged-box/editor/commands",
    method: "POST",
    successBody: editorReceiptBody()
  },
  {
    name: "getEditorOperation",
    call: (client) => client.getEditorOperation("hinged-box", UUID),
    url: `/api/projects/hinged-box/editor/operations/${UUID}`,
    method: "GET",
    successBody: { version: 1, state: "unknown", requestDigest: null }
  }
];

describe("apiClient editor methods (Issue #134 criterion 1)", () => {
  it.each(EDITOR_METHOD_CASES)("$name resolves the strict-parsed success body on its frozen route", async ({ call, url, method, successBody }) => {
    const fetchImpl = vi.fn(async (requestUrl: string | URL, init?: RequestInit) => {
      expect(String(requestUrl)).toBe(url);
      expect(init?.method ?? "GET").toBe(method);
      return jsonResponse(successBody);
    });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(call(client)).resolves.toEqual(successBody);
  });

  it.each(EDITOR_METHOD_CASES)("$name surfaces every frozen error code unchanged as ApiClientError", async ({ call }) => {
    for (const code of ERROR_CODES) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error_code: code, message: `msg for ${code}` }, 400));
      const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

      const failure = call(client);
      await expect(failure).rejects.toBeInstanceOf(ApiClientError);
      await expect(failure).rejects.toMatchObject({ error_code: code, message: `msg for ${code}` });
    }
  });

  it.each(EDITOR_METHOD_CASES)("$name throws on a strict-parse failure — never a best-effort object", async ({ call, successBody }) => {
    // (a) JSON that parses but fails the strict schema.
    const wrongShape = vi.fn(async () => jsonResponse({ ...(successBody as Record<string, unknown>), version: 2 }));
    const clientA = createApiClient({ fetchImpl: wrongShape as unknown as typeof fetch });
    const failureA = call(clientA);
    await expect(failureA).rejects.toBeInstanceOf(ApiClientError);
    await expect(failureA).rejects.toMatchObject({ error_code: "INTERNAL_ERROR", kind: "unparseable-body" });

    // (b) a non-JSON body (e.g. Vite's index.html fallback).
    const html = vi.fn(async () => new Response("<!doctype html><html></html>", { status: 200 }));
    const clientB = createApiClient({ fetchImpl: html as unknown as typeof fetch });
    const failureB = call(clientB);
    await expect(failureB).rejects.toBeInstanceOf(ApiClientError);
    await expect(failureB).rejects.toMatchObject({ error_code: "INTERNAL_ERROR", kind: "unparseable-body" });
  });

  it("commitEditorCommand parses the 200 body as a BARE EditorReceipt (the route does not return an EditorOperationResponse)", async () => {
    const wrapped = vi.fn(async () =>
      jsonResponse({ version: 1, state: "committed", receipt: editorReceiptBody() })
    );
    const client = createApiClient({ fetchImpl: wrapped as unknown as typeof fetch });

    // A wrapped body must NOT parse: the receipt parser rejects the extra fields.
    await expect(client.commitEditorCommand("hinged-box", editorCommitRequestBody())).rejects.toMatchObject({
      kind: "unparseable-body"
    });

    const bare = vi.fn(async () => jsonResponse(editorReceiptBody()));
    const clientB = createApiClient({ fetchImpl: bare as unknown as typeof fetch });
    await expect(clientB.commitEditorCommand("hinged-box", editorCommitRequestBody())).resolves.toEqual(editorReceiptBody());
  });

  it("classifies transport failures without prose parsing: network, unparseable error body", async () => {
    const network = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const clientA = createApiClient({ fetchImpl: network as unknown as typeof fetch });
    await expect(clientA.getEditorDocument("hinged-box")).rejects.toMatchObject({ kind: "network" });

    // A 4xx whose body is NOT a parseable ApiError is "unparseable-body", not
    // a synthesized code the commit classifier could mistake for definite.
    const html409 = vi.fn(async () => new Response("<html>lock busy</html>", { status: 409 }));
    const clientB = createApiClient({ fetchImpl: html409 as unknown as typeof fetch });
    await expect(clientB.getEditorDocument("hinged-box")).rejects.toMatchObject({
      kind: "unparseable-body",
      status: 409
    });
  });

  it("carries the exact ApiError and the HTTP status for the commit classifier", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error_code: "CONFLICT", message: "stale revision" }, 409));
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await client.commitEditorCommand("hinged-box", editorCommitRequestBody()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({
      kind: "http",
      status: 409,
      apiError: { error_code: "CONFLICT", message: "stale revision" }
    });
  });
});
