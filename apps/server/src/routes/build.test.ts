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

describe("POST /api/projects/:projectId/build", () => {
  it("returns the pinned snapshot", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_revision: "rev" })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshot.id).toBe("0001");
  });

  it("maps a stale base_revision to 409 CONFLICT", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_revision: "__stale__" })
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });
  });

  it("rejects a missing `base_revision`", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
  });

  it("404s on an unknown project", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/nope/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_revision: "rev" })
    });
    expect(res.status).toBe(404);
  });

  it("rejects malformed JSON", async () => {
    const app = makeApp();
    const id = await createProject(app);
    const res = await app.request(`/api/projects/${id}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect(res.status).toBe(400);
  });
});
