import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider } from "../test/fakes.js";

async function createProject(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "export-test" })
  });
  return res.json();
}

function makeApp() {
  return createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
}

describe("POST /api/projects/:projectId/export", () => {
  it("exports on a green validation gate", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "3mf" })
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.export.format).toBe("3mf");
    expect(body.validation.badge).toBe("green");
  });

  it("rejects an unsupported format", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "obj" })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "UNSUPPORTED_FORMAT" });
  });

  it("refuses on a failed validation gate without an override (CLAUDE.md hard rule 7)", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "3mf", params: { __forceValidationFailure: true } })
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error_code: "VALIDATION_FAILED" });
  });

  it("exports anyway when allow_validation_failure overrides the gate", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "3mf", params: { __forceValidationFailure: true }, allow_validation_failure: true })
    });
    expect(res.status).toBe(201);
  });
});

describe("GET /api/projects/:projectId/exports/:file", () => {
  it("returns NOT_FOUND for an unknown export file", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/exports/does-not-exist.3mf`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "NOT_FOUND" });
  });

  it("rejects a path-traversal file name as INVALID_REQUEST", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/exports/..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });
});
