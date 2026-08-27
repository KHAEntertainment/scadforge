import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider } from "../test/fakes.js";

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

describe("GET /api/projects/:projectId/params", () => {
  it("returns the frozen ParamsResponse shape", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/params`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.title).toBe("string");
    expect(Array.isArray(body.parameters)).toBe(true);
    expect(body.parameters[0]).toMatchObject({ name: "pipe_d", type: "number" });
    expect(body.values).toEqual({});
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/nope/params");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("rejects an unsafe project id", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/..%2Fetc/params");
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/projects/:projectId/params", () => {
  it("applies a partial update and echoes the merged values", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/params`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { pipe_d: 32 } })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).values).toEqual({ pipe_d: 32 });
  });

  it("rejects a missing `values` object", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/params`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("rejects a non-boolean `snapshot` flag", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/params`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: {}, snapshot: "yes" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/params`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect(res.status).toBe(400);
  });
});
