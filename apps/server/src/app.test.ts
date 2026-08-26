import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider } from "./test/fakes.js";

function makeTestApp() {
  return createApp({
    scadCore: createFakeScadCoreApi(),
    agent: createScriptedAgentProvider([]),
    defaultMaxPasses: 2
  });
}

describe("GET /api/health", () => {
  it("returns the frozen HealthResponse shape", async () => {
    const app = makeTestApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(typeof body.version).toBe("string");
    expect(typeof body.openscad_image === "string" || body.openscad_image === null).toBe(true);
    expect(typeof body.openscad_version === "string" || body.openscad_version === null).toBe(true);
  });
});

describe("unknown route", () => {
  it("returns the frozen error shape with NOT_FOUND", async () => {
    const app = makeTestApp();
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error_code: "NOT_FOUND", message: "Route not found." });
  });
});

describe("oversized request body", () => {
  it("is rejected as INVALID_REQUEST before touching route logic", async () => {
    const app = makeTestApp();
    // A genuinely large body, so `content-length` reflects real size rather
    // than a spoofed header (fetch implementations compute it from the body).
    const oversizedScad = "x".repeat(21 * 1024 * 1024);
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "oversized", scad: oversizedScad })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_code).toBe("INVALID_REQUEST");
  });
});
