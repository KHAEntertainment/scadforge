// SPDX-License-Identifier: Apache-2.0

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
  return (await res.json()).project.id as string;
}

describe("GET /api/projects/:projectId/source", () => {
  it("returns the frozen SourceResponse shape with a revision", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.revision).toBe("string");
    expect(body.revision.length).toBeGreaterThan(0);
    expect(typeof body.scad).toBe("string");
    expect(body.project.id).toBe(id);
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/nope/source");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("rejects an unsafe project id", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/..%2Fetc/source");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/projects/:projectId/source/preflight", () => {
  it("returns the frozen preflight shape for a valid source", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(1);", base_revision: "rev" })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.revision).toBe("string");
    expect(body.syntax_ok).toBe(true);
    expect(body.diagnostics).toBeNull();
    expect(Array.isArray(body.parameters)).toBe(true);
    expect(body.retained_params).toEqual({});
    expect(body.removed_params).toEqual([]);
  });

  it("reports syntax-invalid source as 200 with diagnostics (never a throw)", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "__invalid__", base_revision: "rev" })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.syntax_ok).toBe(false);
    expect(typeof body.diagnostics).toBe("string");
  });

  it("maps a stale base_revision to 409 CONFLICT", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(1);", base_revision: "__stale__" })
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });
  });

  it("rejects a missing `scad`", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_revision: "rev" })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("rejects a missing `base_revision`", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(1);" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/projects/:projectId/source", () => {
  it("saves the source and returns the new SourceResponse", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(2);", base_revision: "rev" })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scad).toBe("cube(2);");
    expect(typeof body.revision).toBe("string");
  });

  it("maps a stale base_revision to 409 CONFLICT", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(2);", base_revision: "__stale__" })
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });
  });

  it("maps invalid syntax to 422 VALIDATION_FAILED", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "__invalid__", base_revision: "rev" })
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error_code: "VALIDATION_FAILED" });
  });

  it("rejects a non-array `discarded_params`", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(2);", base_revision: "rev", discarded_params: "size" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing `base_revision`", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/source`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(2);" })
    });
    expect(res.status).toBe(400);
  });
});
