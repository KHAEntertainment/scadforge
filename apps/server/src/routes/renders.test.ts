// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider } from "../test/fakes.js";

async function createProject(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "render-test" })
  });
  return res.json();
}

function makeApp() {
  return createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
}

describe("POST /api/projects/:projectId/renders", () => {
  it("renders the default view set", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/renders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.views.length).toBeGreaterThan(0);
  });

  it("rejects an invalid view name with INVALID_REQUEST", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/renders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ views: ["not-a-real-view"] })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("returns PROJECT_NOT_FOUND for an unknown project", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/nope/renders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });
});

describe("GET /api/projects/:projectId/snapshots/:snapshotId/views/:view", () => {
  it("rejects an invalid view segment as INVALID_REQUEST", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${project.head.id}/views/not-a-view`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("returns NOT_FOUND when no render exists for that view yet", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${project.head.id}/views/iso`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "NOT_FOUND" });
  });
});
