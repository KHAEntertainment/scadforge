import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";
import {
  createSnapshot,
  initProject,
  listSnapshots,
  readProjectManifest,
  readSnapshotManifest,
  recordExport,
  revertToSnapshot
} from "./store.js";
import { snapshotDir } from "./paths.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-store-test-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

describe("project store (filesystem, temp dir)", () => {
  it("initProject creates project.json and the first ('initial') snapshot", async () => {
    const { project, snapshot } = await initProject(projectDir, {
      id: "proj-1",
      name: "Test Project",
      provider: providerConfig,
      content: "cube([10,10,10]);\n",
      params: { size: 10 }
    });

    expect(project.schema_version).toBe(1);
    expect(project.head).toBe("0001");
    expect(snapshot.id).toBe("0001");
    expect(snapshot.parent).toBeNull();
    expect(snapshot.origin).toBe("initial");
    expect(snapshot.files.diff_patch).toBeNull(); // no parent -> no diff
    expect(snapshot.params).toEqual({ size: 10 });

    const rootModel = await readFile(join(projectDir, PROJECT_LAYOUT.modelFile), "utf8");
    expect(rootModel).toBe("cube([10,10,10]);\n");
  });

  it("createSnapshot chains a second snapshot with parent=0001 and a real unified diff", async () => {
    await initProject(projectDir, {
      id: "proj-1",
      name: "Test",
      provider: providerConfig,
      content: "cube([10,10,10]);\n"
    });

    const second = await createSnapshot(projectDir, {
      content: "cube([20,20,20]);\n",
      params: { size: 20 },
      message: "made it bigger",
      origin: "manual",
      pass: null
    });

    expect(second.id).toBe("0002");
    expect(second.parent).toBe("0001");
    expect(second.files.diff_patch).toBe(PROJECT_LAYOUT.snapshot.diffFile);

    const diffContent = await readFile(join(snapshotDir(projectDir, "0002"), PROJECT_LAYOUT.snapshot.diffFile), "utf8");
    expect(diffContent).toContain("-cube([10,10,10]);");
    expect(diffContent).toContain("+cube([20,20,20]);");

    const project = await readProjectManifest(projectDir);
    expect(project.head).toBe("0002");

    const rootModel = await readFile(join(projectDir, PROJECT_LAYOUT.modelFile), "utf8");
    expect(rootModel).toBe("cube([20,20,20]);\n");
  });

  it("persists a validation report verbatim to validation.json plus a manifest summary", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const report = {
      manifold: true,
      status: "NoError" as const,
      volume_mm3: 1,
      surface_area: 6,
      bbox: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
      triangle_count: 12,
      components: 1,
      genus: 0
    };
    const gate = { ok: true, badge: "green" as const, failures: [], warnings: [] };

    const snap = await createSnapshot(projectDir, {
      content: "cube(1);\n",
      params: {},
      message: "validated",
      origin: "manual",
      pass: null,
      validation: { report, gate }
    });

    expect(snap.validation).toEqual({ badge: "green", manifold: true, components: 1, volume_mm3: 1, warning_count: 0 });
    const persisted = JSON.parse(
      await readFile(join(snapshotDir(projectDir, snap.id), PROJECT_LAYOUT.snapshot.validationFile), "utf8")
    );
    expect(persisted).toEqual(report);
  });

  it("revert copies a target snapshot's files forward as a NEW snapshot -- append-only, never mutates history", async () => {
    await initProject(projectDir, {
      id: "p",
      name: "n",
      provider: providerConfig,
      content: "cube([10,10,10]);\n",
      params: { size: 10 }
    });
    await createSnapshot(projectDir, {
      content: "cube([20,20,20]);\n",
      params: { size: 20 },
      message: "v2",
      origin: "manual",
      pass: null
    });
    await createSnapshot(projectDir, {
      content: "cube([30,30,30]);\n",
      params: { size: 30 },
      message: "v3",
      origin: "manual",
      pass: null
    });

    const before0001 = await readSnapshotManifest(projectDir, "0001");
    const before0002 = await readSnapshotManifest(projectDir, "0002");

    const reverted = await revertToSnapshot(projectDir, "0001");

    expect(reverted.id).toBe("0004"); // a NEW snapshot, not a rewrite of 0001
    expect(reverted.parent).toBe("0003"); // parented on the current head, not on the revert target
    expect(reverted.origin).toBe("revert");
    expect(reverted.params).toEqual({ size: 10 });

    const rootModel = await readFile(join(projectDir, PROJECT_LAYOUT.modelFile), "utf8");
    expect(rootModel).toBe("cube([10,10,10]);\n");

    // History is untouched: 0001 and 0002 are byte-identical to before the revert.
    const after0001 = await readSnapshotManifest(projectDir, "0001");
    const after0002 = await readSnapshotManifest(projectDir, "0002");
    expect(after0001).toEqual(before0001);
    expect(after0002).toEqual(before0002);

    const allSnapshots = await listSnapshots(projectDir);
    expect(allSnapshots.map((s) => s.id)).toEqual(["0001", "0002", "0003", "0004"]);

    const project = await readProjectManifest(projectDir);
    expect(project.head).toBe("0004");
  });

  it("recordExport appends to an append-only exports ledger", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });
    await recordExport(projectDir, {
      snapshot: "0001",
      format: "3mf",
      file: "proj-0001.3mf",
      url: "/exports/proj-0001.3mf",
      bytes: 1234,
      timestamp: new Date().toISOString(),
      validation_overridden: false
    });
    await recordExport(projectDir, {
      snapshot: "0001",
      format: "stl",
      file: "proj-0001.stl",
      url: "/exports/proj-0001.stl",
      bytes: 999,
      timestamp: new Date().toISOString(),
      validation_overridden: true
    });

    const raw = await readFile(join(projectDir, PROJECT_LAYOUT.metaDir, PROJECT_LAYOUT.exportsDir, "index.json"), "utf8");
    const records = JSON.parse(raw);
    expect(records).toHaveLength(2);
    expect(records[1].validation_overridden).toBe(true);
  });

  // ── COUNTEREXAMPLES: missing/malformed/boundary ──

  it("readProjectManifest on a directory that is not a project -> typed PROJECT_NOT_FOUND", async () => {
    await expect(readProjectManifest(projectDir)).rejects.toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("readSnapshotManifest for a snapshot id that does not exist -> typed SNAPSHOT_NOT_FOUND", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });
    await expect(readSnapshotManifest(projectDir, "9999")).rejects.toBeInstanceOf(ScadForgeError);
    await expect(readSnapshotManifest(projectDir, "9999")).rejects.toMatchObject({ error_code: "SNAPSHOT_NOT_FOUND" });
  });

  it("revertToSnapshot on an unknown target -> typed error, no partial/corrupt snapshot left behind", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });
    await expect(revertToSnapshot(projectDir, "0042")).rejects.toBeInstanceOf(ScadForgeError);
    // No new snapshot should have been created from the failed revert attempt.
    const snapshots = await listSnapshots(projectDir);
    expect(snapshots.map((s) => s.id)).toEqual(["0001"]);
  });

  it("listSnapshots on an empty/nonexistent project -> typed error, not a bare fs exception", async () => {
    await expect(listSnapshots(projectDir)).rejects.toBeInstanceOf(ScadForgeError);
  });

  it("handles a snapshot message containing no fenced code (CLAUDE.md rule 5 is enforced upstream; store just persists whatever string it is given verbatim)", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });
    const snap = await createSnapshot(projectDir, {
      content: "cube(2);\n",
      params: {},
      message: "plain one-line summary",
      origin: "agent",
      pass: 1
    });
    expect(snap.message).toBe("plain one-line summary");
    expect(snap.pass).toBe(1);
  });
});
