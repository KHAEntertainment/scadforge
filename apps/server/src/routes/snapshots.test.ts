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

describe("GET /api/projects/:projectId/snapshots/:snapshotId/diff", () => {
  it("returns an empty diff for the first snapshot, per the frozen contract", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const snapshotId = project.head.id;
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${snapshotId}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: snapshotId, parent: null, diff: "" });
  });

  it("returns SNAPSHOT_NOT_FOUND for an unknown snapshot id", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/9999/diff`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "SNAPSHOT_NOT_FOUND" });
  });

  it("rejects a path-traversal snapshot id as INVALID_REQUEST", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/..%2F..%2Fsecret/diff`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
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

    // Append-only: the reverted-from snapshot must still exist, intact, alongside the new one.
    const list = await app.request(`/api/projects/${project.project.id}/snapshots`);
    const listBody = await list.json();
    expect(listBody.snapshots).toHaveLength(2);
    const original = await app.request(`/api/projects/${project.project.id}/snapshots/${snapshotId}`);
    expect(original.status).toBe(200);
    expect((await original.json()).snapshot.id).toBe(snapshotId);
  });

  it("returns SNAPSHOT_NOT_FOUND for an unknown target snapshot", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/9999/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "SNAPSHOT_NOT_FOUND" });
  });

  it("rejects a non-string `message` as INVALID_REQUEST", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const snapshotId = project.head.id;
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${snapshotId}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: 42 })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("counterexample: under write contention, revert surfaces the typed CONFLICT as 409 rather than silently overwriting (M1 store concurrency policy)", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const snapshotId = project.head.id;
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${snapshotId}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "__forceConflict__" })
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error_code: "CONFLICT" });

    // No new snapshot was appended — the conflict must not leave a partial/duplicate entry.
    const list = await app.request(`/api/projects/${project.project.id}/snapshots`);
    expect((await list.json()).snapshots).toHaveLength(1);
  });
});

// ── the snapshot mesh route (Issue #41) ──────────────────────────────────────
//
// The 3D preview was permanently blank in part because nothing served a mesh
// for a snapshot. These lock the route's contract, including the case that
// makes the viewer's messaging correct: a snapshot that simply has no mesh.

describe("GET /api/projects/:projectId/snapshots/:snapshotId/mesh", () => {
  /** Marks a snapshot as validated, which is what causes a mesh to exist. */
  function markValidated(scadCore: ReturnType<typeof createFakeScadCoreApi>, projectId: string, snapshotId: string) {
    const snapshot = scadCore._projects.get(projectId)?.snapshots.find((s) => s.id === snapshotId);
    if (!snapshot) throw new Error(`test setup: no snapshot ${snapshotId}`);
    snapshot.validation = {
      badge: "amber",
      manifold: true,
      components: 5,
      volume_mm3: 164079.57,
      warning_count: 1
    };
  }

  it("serves the persisted mesh bytes for a validated snapshot", async () => {
    const scadCore = createFakeScadCoreApi();
    const app = createApp({ scadCore, agent: createScriptedAgentProvider([]) });
    const project = await createProject(app);
    const projectId = project.project.id;
    const snapshotId = project.head.id;
    markValidated(scadCore, projectId, snapshotId);

    const res = await app.request(`/api/projects/${projectId}/snapshots/${snapshotId}/mesh`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/stl");
    // The viewer streams these bytes into three.js's STLLoader, so the body
    // must be the mesh verbatim — not a JSON envelope around it.
    expect(await res.text()).toBe(`fake-stl:${projectId}:${snapshotId}`);
  });

  it("counterexample: a snapshot with no persisted mesh 404s instead of erroring or serving an empty body", async () => {
    const app = makeApp();
    const project = await createProject(app);
    // The initial snapshot was never validated, so no mesh was ever rendered
    // for it. That is an ordinary state, and the viewer renders the 404 as an
    // explanation rather than as a failure.
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/${project.head.id}/mesh`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "NOT_FOUND" });
  });

  it("404s for an unknown snapshot id", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/9999/mesh`);
    expect(res.status).toBe(404);
  });

  it("rejects a path-traversal snapshot id as INVALID_REQUEST", async () => {
    const app = makeApp();
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/snapshots/..%2F..%2Fetc%2Fpasswd/mesh`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("answers HEAD, which is how the web client probes for a mesh without downloading it", async () => {
    const scadCore = createFakeScadCoreApi();
    const app = createApp({ scadCore, agent: createScriptedAgentProvider([]) });
    const project = await createProject(app);
    const projectId = project.project.id;
    const snapshotId = project.head.id;

    // `useSnapshotMesh` distinguishes "has a mesh" from "has none" purely by
    // this status code, so both directions are load-bearing.
    const before = await app.request(`/api/projects/${projectId}/snapshots/${snapshotId}/mesh`, { method: "HEAD" });
    expect(before.status).toBe(404);

    markValidated(scadCore, projectId, snapshotId);
    const after = await app.request(`/api/projects/${projectId}/snapshots/${snapshotId}/mesh`, { method: "HEAD" });
    expect(after.status).toBe(200);
  });
});
