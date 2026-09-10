import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";
import {
  ORPHANED_CLAIM_MIN_AGE_MS,
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

  it("recovers from an orphaned claim directory left by a hard kill (issue #28)", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    // Simulate a SIGKILL between claimNextSnapshotId's exclusive mkdir and
    // the manifest write: history/0002 exists with partial snapshot files but
    // NO manifest.json, and project.json.head never advanced past 0001.
    // Backdate the directory past the reclaim age so it is unambiguously dead
    // claim debris, not an in-flight writer from another process.
    const orphan = snapshotDir(projectDir, "0002");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, PROJECT_LAYOUT.snapshot.modelFile), "cube(2);\n", "utf8");
    const past = new Date(Date.now() - 2 * ORPHANED_CLAIM_MIN_AGE_MS);
    await utimes(orphan, past, past);

    // Before the fix this wedged permanently: every retry recomputed id 0002
    // against the unchanged head and hit EEXIST until CONFLICT. Now the dead
    // claim is reclaimed and creation succeeds again.
    const recovered = await createSnapshot(projectDir, {
      content: "cube(3);\n",
      params: {},
      message: "recovered after orphaned claim",
      origin: "manual",
      pass: null
    });

    expect(recovered.id).toBe("0002"); // the reclaimed id is reused -- sequence stays gapless
    expect(recovered.message).toBe("recovered after orphaned claim");

    // The committed 0001 snapshot was never touched.
    const first = await readSnapshotManifest(projectDir, "0001");
    expect(first.origin).toBe("initial");

    // The store keeps working: the next snapshot gets 0003.
    const next = await createSnapshot(projectDir, {
      content: "cube(4);\n",
      params: {},
      message: "after recovery",
      origin: "manual",
      pass: null
    });
    expect(next.id).toBe("0003");
    expect(next.parent).toBe("0002");
  }, 20000);

  it("never reclaims a stale directory that contains a manifest.json (issue #28)", async () => {
    await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    // Simulate a torn commit: history/0002 carries a manifest.json but
    // project.json.head never advanced. However stale, the manifest makes it
    // a real snapshot -- reclaiming it would destroy committed history.
    const torn = snapshotDir(projectDir, "0002");
    await mkdir(torn, { recursive: true });
    const tornManifest = {
      id: "0002",
      parent: "0001",
      timestamp: new Date().toISOString(),
      origin: "manual",
      message: "torn commit",
      files: {},
      params: {}
    };
    await writeFile(join(torn, PROJECT_LAYOUT.snapshot.manifestFile), JSON.stringify(tornManifest), "utf8");
    const past = new Date(Date.now() - 2 * ORPHANED_CLAIM_MIN_AGE_MS);
    await utimes(torn, past, past);

    // The claim must NOT reclaim it: the loop still exhausts and surfaces the
    // typed CONFLICT rather than silently overwriting real history.
    await expect(
      createSnapshot(projectDir, {
        content: "cube(2);\n",
        params: {},
        message: "must not destroy the torn commit",
        origin: "manual",
        pass: null
      })
    ).rejects.toMatchObject({ error_code: "CONFLICT" });

    // The manifest-bearing directory survived intact.
    const manifest = JSON.parse(await readFile(join(torn, PROJECT_LAYOUT.snapshot.manifestFile), "utf8"));
    expect(manifest.id).toBe("0002");
  }, 20000);
});
