import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider } from "../test/fakes.js";

function makeApp() {
  return createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
}

describe("POST /api/projects", () => {
  it("creates a project and returns the frozen ProjectResponse shape", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "my-bracket" })
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.project.name).toBe("my-bracket");
    expect(body.project.schema_version).toBe(1);
    expect(body.head).not.toBeNull();
    expect(body.scad).toBe("");
  });

  it("rejects a missing name with INVALID_REQUEST", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("rejects malformed JSON with INVALID_REQUEST", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });
});

describe("GET /api/projects/:projectId", () => {
  it("returns PROJECT_NOT_FOUND for an unknown id", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("rejects a path-traversal project id as INVALID_REQUEST, never touching the store", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("round-trips a created project", async () => {
    const app = makeApp();
    const create = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "roundtrip" })
    });
    const created = await create.json();
    const get = await app.request(`/api/projects/${created.project.id}`);
    expect(get.status).toBe(200);
    const fetched = await get.json();
    expect(fetched.project.id).toBe(created.project.id);
  });
});

describe("GET /api/projects", () => {
  it("lists created projects", async () => {
    const app = makeApp();
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "one" })
    });
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects.length).toBeGreaterThan(0);
  });
});
