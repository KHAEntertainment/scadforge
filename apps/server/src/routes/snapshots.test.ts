import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider } from "../test/fakes.js";

async function createProject(app: ReturnType<typeof createApp>, name = "snap-test") {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  return res.json();
}

function makeApp() {
  return createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
}

describe("GET /api/projects/:projectId/snapshots", () => {
  it("lists the initial snapshot for a freshly created project", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].origin).toBe("initial");
  });

  it("returns PROJECT_NOT_FOUND for an unknown project", async () => {
    const app = makeApp();
    const res = await app.request("/api/projects/nope/snapshots");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });
});

describe("GET /api/projects/:projectId/snapshots/:snapshotId", () => {
  it("returns SNAPSHOT_NOT_FOUND for an unknown snapshot id", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/9999`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "SNAPSHOT_NOT_FOUND" });
  });

  it("rejects a path-traversal snapshot id as INVALID_REQUEST", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/..%2F..%2Fsecret`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("fetches a known snapshot by id", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const snapshotId = project.head.id;
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${snapshotId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshot.id).toBe(snapshotId);
  });
});

describe("POST /api/projects/:projectId/snapshots/:snapshotId/revert", () => {
  it("appends a new revert snapshot (append-only history)", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const snapshotId = project.head.id;
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${snapshotId}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.snapshot.origin).toBe("revert");
    expect(body.snapshot.id).not.toBe(snapshotId);

    const list = await app.request(`/api/projects/${project.project.id}/snapshots`);
    const listBody = await list.json();
    expect(listBody.snapshots).toHaveLength(2);
  });
});
