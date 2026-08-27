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
