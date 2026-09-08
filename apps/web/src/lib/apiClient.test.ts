import { describe, expect, it, vi } from "vitest";
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
