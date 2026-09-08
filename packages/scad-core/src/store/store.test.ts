import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";
import {
  createSnapshot,
  initProject,
  listSnapshots,
  mergeParamsAtomic,
  readProjectManifest,
  readSnapshotManifest,
  recordExport,
  revertToSnapshot
} from "./store.js";
import { snapshotDir, rootParamsPath } from "./paths.js";
import {
  attachRendersToSnapshot,
  attachValidationToSnapshot,
  resolveSnapshotMeshPath,
  resolveSnapshotRenderPath,
  resolveSnapshotValidationPath,
  SNAPSHOT_MESH_FILE,
  snapshotMeshPath
} from "./attachments.js";

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

  it("revert restores every available derived artifact into the NEW snapshot with URLs for the new id", async () => {
    await initProject(projectDir, {
      id: "p",
      name: "n",
      provider: providerConfig,
      content: "cube([10,10,10]);\n",
      params: { size: 10 }
    });

    const sourcePng = join(projectDir, "source-iso.png");
    const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const meshBytes = Buffer.from("target mesh bytes");
    await writeFile(sourcePng, pngBytes);
    await attachRendersToSnapshot(
      projectDir,
      "0001",
      [{ view: "iso", sourcePath: sourcePng, render_ms: 42, width: 1024, height: 768 }],
      { buildRenderUrl: (id, view) => `/api/projects/p/snapshots/${id}/views/${view}` }
    );
    await attachValidationToSnapshot(projectDir, "0001", {
      report: {
        manifold: true,
        status: "NoError",
        volume_mm3: 1000,
        surface_area: 600,
        bbox: { min: [0, 0, 0], max: [10, 10, 10] },
        triangle_count: 12,
        components: 1,
        genus: 0
      },
      gate: { ok: true, badge: "green", failures: [], warnings: [] },
      export_ms: 10,
      validate_ms: 2
    });
    await writeFile(snapshotMeshPath(projectDir, "0001"), meshBytes);

    await createSnapshot(projectDir, {
      content: "cube([20,20,20]);\n",
      params: { size: 20 },
      message: "edited",
      origin: "manual",
      pass: null
    });

    const oldManifestPath = join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile);
    const oldManifestBefore = await readFile(oldManifestPath);
    const oldRenderBefore = await readFile((await resolveSnapshotRenderPath(projectDir, "0001", "iso"))!);
    const oldValidationBefore = await readFile((await resolveSnapshotValidationPath(projectDir, "0001"))!);
    const oldMeshBefore = await readFile((await resolveSnapshotMeshPath(projectDir, "0001"))!);

    const reverted = await revertToSnapshot(projectDir, "0001", {
      buildRenderUrl: (id, view) => `/api/projects/p/snapshots/${id}/views/${view}`
    });

    expect(reverted.id).toBe("0003");
    expect(reverted.renders).toEqual([
      expect.objectContaining({
        view: "iso",
        url: "/api/projects/p/snapshots/0003/views/iso",
        width: 1024,
        height: 768,
        bytes: pngBytes.byteLength,
        render_ms: 42
      })
    ]);
    expect(reverted.validation).toEqual({
      badge: "green",
      manifold: true,
      components: 1,
      volume_mm3: 1000,
      warning_count: 0
    });
    await expect(readFile((await resolveSnapshotRenderPath(projectDir, "0003", "iso"))!)).resolves.toEqual(pngBytes);
    await expect(readFile((await resolveSnapshotValidationPath(projectDir, "0003"))!)).resolves.toEqual(
      oldValidationBefore
    );
    await expect(readFile((await resolveSnapshotMeshPath(projectDir, "0003"))!)).resolves.toEqual(meshBytes);

    // Restoring forward only reads the source snapshot: both immutable history
    // and the source's derived artifacts stay byte-identical.
    await expect(readFile(oldManifestPath)).resolves.toEqual(oldManifestBefore);
    await expect(readFile((await resolveSnapshotRenderPath(projectDir, "0001", "iso"))!)).resolves.toEqual(
      oldRenderBefore
    );
    await expect(readFile((await resolveSnapshotValidationPath(projectDir, "0001"))!)).resolves.toEqual(
      oldValidationBefore
    );
    await expect(readFile((await resolveSnapshotMeshPath(projectDir, "0001"))!)).resolves.toEqual(oldMeshBefore);
  });

  it("revert copies legacy history-backed artifacts into the NEW derived tree and leaves legacy bytes untouched", async () => {
    await initProject(projectDir, {
      id: "p",
      name: "n",
      provider: providerConfig,
      content: "cube([8,8,8]);\n",
      params: { size: 8 }
    });

    // Emulate a project created before derived/ existed: all three artifact
    // kinds and their manifest metadata live directly in history/0001.
    const legacyDir = snapshotDir(projectDir, "0001");
    const legacyViewsDir = join(legacyDir, PROJECT_LAYOUT.snapshot.viewsDir);
    const legacyRender = Buffer.from("legacy png bytes");
    const legacyMesh = Buffer.from("legacy mesh bytes");
    const legacyReport = {
      manifold: true,
      status: "NoError" as const,
      volume_mm3: 512,
      surface_area: 384,
      bbox: { min: [0, 0, 0] as [number, number, number], max: [8, 8, 8] as [number, number, number] },
      triangle_count: 12,
      components: 1,
      genus: 0
    };
    await mkdir(legacyViewsDir, { recursive: true });
    await writeFile(join(legacyViewsDir, "iso.png"), legacyRender);
    await writeFile(
      join(legacyDir, PROJECT_LAYOUT.snapshot.validationFile),
      JSON.stringify(legacyReport, null, 2),
      "utf8"
    );
    await writeFile(join(legacyDir, SNAPSHOT_MESH_FILE), legacyMesh);

    const legacyManifestPath = join(legacyDir, PROJECT_LAYOUT.snapshot.manifestFile);
    const legacyManifest = JSON.parse(await readFile(legacyManifestPath, "utf8"));
    legacyManifest.renders = [
      {
        view: "iso",
        file: "views/iso.png",
        url: "/api/projects/p/snapshots/0001/views/iso",
        width: 640,
        height: 480,
        bytes: legacyRender.byteLength,
        render_ms: 7
      }
    ];
    legacyManifest.validation = {
      badge: "green",
      manifold: true,
      components: 1,
      volume_mm3: 512,
      warning_count: 0
    };
    legacyManifest.files.validation_json = PROJECT_LAYOUT.snapshot.validationFile;
    await writeFile(legacyManifestPath, JSON.stringify(legacyManifest, null, 2), "utf8");

    await createSnapshot(projectDir, {
      content: "cube([9,9,9]);\n",
      params: { size: 9 },
      message: "edited",
      origin: "manual",
      pass: null
    });

    const oldManifestBefore = await readFile(legacyManifestPath);
    const oldRenderBefore = await readFile(join(legacyViewsDir, "iso.png"));
    const oldValidationBefore = await readFile(join(legacyDir, PROJECT_LAYOUT.snapshot.validationFile));
    const oldMeshBefore = await readFile(join(legacyDir, SNAPSHOT_MESH_FILE));

    const reverted = await revertToSnapshot(projectDir, "0001", {
      buildRenderUrl: (id, view) => `/api/projects/p/snapshots/${id}/views/${view}`
    });
    expect(reverted.id).toBe("0003");
    expect(reverted.renders[0]?.url).toBe("/api/projects/p/snapshots/0003/views/iso");
    expect(reverted.validation?.volume_mm3).toBe(512);
    await expect(readFile((await resolveSnapshotRenderPath(projectDir, "0003", "iso"))!)).resolves.toEqual(
      legacyRender
    );
    await expect(readFile((await resolveSnapshotValidationPath(projectDir, "0003"))!)).resolves.toEqual(
      oldValidationBefore
    );
    await expect(readFile((await resolveSnapshotMeshPath(projectDir, "0003"))!)).resolves.toEqual(legacyMesh);

    // The restored copies are derived, never inserted into the new immutable
    // history directory, and every legacy source byte remains untouched.
    await expect(readFile(join(snapshotDir(projectDir, "0003"), "views", "iso.png"))).rejects.toThrow();
    await expect(
      readFile(join(snapshotDir(projectDir, "0003"), PROJECT_LAYOUT.snapshot.validationFile))
    ).rejects.toThrow();
    await expect(readFile(join(snapshotDir(projectDir, "0003"), SNAPSHOT_MESH_FILE))).rejects.toThrow();
    await expect(readFile(legacyManifestPath)).resolves.toEqual(oldManifestBefore);
    await expect(readFile(join(legacyViewsDir, "iso.png"))).resolves.toEqual(oldRenderBefore);
    await expect(readFile(join(legacyDir, PROJECT_LAYOUT.snapshot.validationFile))).resolves.toEqual(
      oldValidationBefore
    );
    await expect(readFile(join(legacyDir, SNAPSHOT_MESH_FILE))).resolves.toEqual(oldMeshBefore);
  });

  it("revert gracefully omits artifact metadata whose legacy bytes are absent", async () => {
    await initProject(projectDir, {
      id: "p",
      name: "n",
      provider: providerConfig,
      content: "cube(1);\n"
    });
    const manifestPath = join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.renders = [
      {
        view: "iso",
        file: "views/iso.png",
        url: "/stale/0001/iso",
        width: 1,
        height: 1,
        bytes: 123,
        render_ms: null
      }
    ];
    manifest.validation = {
      badge: "green",
      manifold: true,
      components: 1,
      volume_mm3: 1,
      warning_count: 0
    };
    manifest.files.validation_json = PROJECT_LAYOUT.snapshot.validationFile;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await createSnapshot(projectDir, {
      content: "cube(2);\n",
      params: {},
      message: "edited",
      origin: "manual",
      pass: null
    });

    const reverted = await revertToSnapshot(projectDir, "0001");
    expect(reverted.renders).toEqual([]);
    expect(reverted.validation).toBeNull();
    await expect(resolveSnapshotMeshPath(projectDir, reverted.id)).resolves.toBeNull();
  });

  // Issue #44: `revertToSnapshot` also writes root `params.json` (it REPLACES
  // it wholesale with the target's own bag) and must hold the SAME params
  // lock as `mergeParamsAtomic`, or a concurrent params update could
  // interleave with its `createSnapshot` write of the same shared files.
  it("revertToSnapshot holds the params lock -- fully serialized against a concurrent mergeParamsAtomic writer, never interleaved", async () => {
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

    const events: string[] = [];
    const slowMerge = mergeParamsAtomic(projectDir, { extra: 99 }, async (merged) => {
      events.push("merge-start");
      await new Promise((r) => setTimeout(r, 40));
      await writeFile(
        rootParamsPath(projectDir),
        JSON.stringify({ fileFormatVersion: 1, parameterSets: { current: merged } }, null, 2),
        "utf8"
      );
      events.push("merge-end");
      return merged;
    });
    // No direct hook inside `revertToSnapshot` to bracket with events, but it
    // acquires the SAME lock via `withParamsLock` before its `createSnapshot`
    // call -- if that lock is real, `revertToSnapshot` can only run either
    // entirely BEFORE `merge-start` or entirely AFTER `merge-end`, never
    // overlapping the 40ms window in between.
    const revert = revertToSnapshot(projectDir, "0001").then(() => events.push("revert-done"));

    await Promise.all([slowMerge, revert]);

    const mergeStart = events.indexOf("merge-start");
    const mergeEnd = events.indexOf("merge-end");
    const revertDone = events.indexOf("revert-done");
    // revert-done is never BETWEEN merge-start and merge-end (which would
    // mean revert's write landed while merge was still mid-critical-section).
    const revertBeforeMerge = revertDone < mergeStart;
    const revertAfterMerge = revertDone > mergeEnd;
    expect(revertBeforeMerge || revertAfterMerge).toBe(true);

    // And whichever ran last fully committed its OWN coherent value -- no
    // torn write mixing the two.
    const raw = JSON.parse(await readFile(rootParamsPath(projectDir), "utf8"));
    const values = raw.parameterSets.current;
    const isRevertOnly = values.size === 10 && values.extra === undefined;
    const isMergeAfterRevert = values.extra === 99 && values.size === 10;
    expect(isRevertOnly || isMergeAfterRevert).toBe(true);
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

  // ── CONCURRENCY (issue #14 / PR #27: claimNextSnapshotId's exclusive-mkdir
  // claim + retry, see the CONCURRENCY POLICY comment in store.ts) ──

  it("N concurrent createSnapshot calls on the same project yield N distinct ids -- every payload readable, no collision/overwrite", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createSnapshot(projectDir, {
          content: `cube(${i + 2});\n`,
          params: { n: i },
          message: `concurrent snapshot #${i}`,
          origin: "manual",
          pass: null
        })
      )
    );

    // No two concurrent callers collided on the same id.
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(N);

    // Every one of the N payloads is intact and independently readable --
    // the defect this fix closes was one writer's files silently landing on
    // top of another's, which would show up here as lost/mismatched content.
    for (let i = 0; i < N; i++) {
      const r = results[i]!;
      const persisted = await readSnapshotManifest(projectDir, r.id);
      expect(persisted.message).toBe(`concurrent snapshot #${i}`);
      expect(persisted.params).toEqual({ n: i });
      const modelContent = await readFile(join(snapshotDir(projectDir, r.id), persisted.files.model_scad), "utf8");
      expect(modelContent).toBe(`cube(${i + 2});\n`);
    }

    // Gapless: the initial snapshot plus all N concurrent ones, each id used
    // exactly once.
    const allSnapshots = await listSnapshots(projectDir);
    expect(allSnapshots).toHaveLength(N + 1);
    expect(new Set(allSnapshots.map((s) => s.id)).size).toBe(N + 1);

    // project.json.head lands on whichever id was allocated last -- i.e. it
    // is a real id from this run, not stale/duplicated.
    const project = await readProjectManifest(projectDir);
    expect(new Set(ids).has(project.head as string)).toBe(true);
  });

  it("exhausting SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS surfaces the typed CONFLICT error instead of silently overwriting", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    // Simulate pathological contention that never clears: pre-claim the
    // directory the next createSnapshot call would need. Because
    // project.json.head never changes in this test, every retry inside
    // claimNextSnapshotId recomputes the SAME next id and hits EEXIST every
    // time -- the loop must deterministically exhaust
    // SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS and fail with the typed CONFLICT error
    // rather than ever falling back to overwriting the pre-existing directory.
    const contestedDir = snapshotDir(projectDir, "0002");
    await mkdir(contestedDir, { recursive: true });
    await writeFile(join(contestedDir, "sentinel.txt"), "pre-existing, must survive", "utf8");

    await expect(
      createSnapshot(projectDir, {
        content: "cube(2);\n",
        params: {},
        message: "should conflict, not overwrite",
        origin: "manual",
        pass: null
      })
    ).rejects.toMatchObject({ error_code: "CONFLICT" });

    // The pre-existing (contested) directory's contents were never touched.
    const sentinel = await readFile(join(contestedDir, "sentinel.txt"), "utf8");
    expect(sentinel).toBe("pre-existing, must survive");
  }, 20000);
});
