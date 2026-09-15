// SPDX-License-Identifier: Apache-2.0
//
// @docker -- Issue #45 regression suite: a snapshot's own files must never
// change after creation, and validating/rendering/exporting must always
// describe the snapshot it's attached to (its OWN persisted model/params),
// never the project's current root state. Needs Docker: `validate_mesh` /
// `render_views` / `export` all run the real pinned OpenSCAD CLI.
//
// Root cause (see agent-scad-core.ts / scad-core-impl.ts headers): the OLD
// code (a) rewrote `history/<id>/manifest.json` + `validation.json` directly
// on every `validate_mesh`/`render_views` call, and (b) always validated/
// rendered/exported `rootModelPath(dir)` (the project's CURRENT root file)
// while attaching the result to whatever `project.head` happened to be —
// re-read AFTER the (slow) OpenSCAD work, not pinned before it. Any
// intervening `write_scad`/`set_params`, or simply an unsnapshotted
// (`snapshot:false`) params write, could make that attach describe content
// that is NOT the target snapshot's own persisted `model.scad`/`params.json`.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import type { SnapshotManifest } from "@scadforge/protocol";
import {
  EMPTY_SIDECAR,
  initProject,
  parseStl,
  readSnapshotManifest,
  resolveSnapshotValidationPath,
  sidecarDigest,
  snapshotDir
} from "@scadforge/scad-core";
import { createAgentScadCore } from "./agent-scad-core.js";
import { createScadCoreApi } from "./scad-core-impl.js";
import { createServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

function dockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// One Customizer parameter, `size` in [5:50], LITERAL default 20 -- so any
// validation/render that (wrongly) falls back to the .scad source's own
// hardcoded default, instead of the target snapshot's persisted params.json,
// is distinguishable from one that correctly used size=30 or size=45.
const MODEL_SOURCE = "size = 20; // [5:50]\ncube([size, size, size]);\n";

let root: string;

function runtimeFor(dir: string) {
  return createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: dir } as NodeJS.ProcessEnv);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scadforge-snapshot-immutability-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedProject(id = "bracket") {
  const runtime = runtimeFor(root);
  const dir = runtime.dirFor(id);
  await initProject(dir, { id, name: "Bracket", provider: runtime.provider, content: MODEL_SOURCE, message: "Initial snapshot" });
  return { runtime, dir };
}

/** A stable checksum of every file in `history/<id>/`, recursively, by RELATIVE path -- proves byte-for-byte identity regardless of directory-entry ordering. */
async function checksumSnapshotDir(dir: string, id: string): Promise<Record<string, string>> {
  const base = snapshotDir(dir, id);
  const sums: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const bytes = await readFile(full);
        sums[relative(base, full)] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  }
  await walk(base);
  return sums;
}

describe.skipIf(!dockerAvailable())("@docker Issue #45: snapshots are immutable after creation", () => {
  it("validate_mesh leaves the ENTIRE history/<id>/ directory byte-identical", async () => {
    const { runtime, dir } = await seedProject();
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    const before = await checksumSnapshotDir(dir, "0001");
    await agentCore.validateMesh({});
    const after = await checksumSnapshotDir(dir, "0001");

    expect(after).toEqual(before);
  }, 60_000);

  it("render_views leaves the ENTIRE history/<id>/ directory byte-identical", async () => {
    const { runtime, dir } = await seedProject();
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    const before = await checksumSnapshotDir(dir, "0001");
    await agentCore.renderViews({ views: ["iso"] });
    const after = await checksumSnapshotDir(dir, "0001");

    expect(after).toEqual(before);
  }, 60_000);

  it("export leaves the ENTIRE history/<id>/ directory byte-identical", async () => {
    const { runtime, dir } = await seedProject();
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });
    const rest = createScadCoreApi(runtime);

    const before = await checksumSnapshotDir(dir, "0001");
    await rest.runExport("bracket", { format: "stl" });
    await agentCore.exportModel({ format: "3mf" });
    const after = await checksumSnapshotDir(dir, "0001");

    expect(after).toEqual(before);
  }, 60_000);

  it("returns validation for the exact explicit-params geometry that was exported", async () => {
    const { runtime } = await seedProject();
    const rest = createScadCoreApi(runtime);

    const response = await rest.runExport("bracket", { format: "stl", params: { size: 35 } });
    const file = await rest.getExportFile("bracket", response.export.file);
    expect(file).not.toBeNull();

    const triangles = parseStl(Buffer.from(file!.data));
    const maxCoord = Math.max(...triangles.flatMap((triangle) => triangle.flatMap((vertex) => vertex)));
    expect(maxCoord).toBeCloseTo(35, 1);
    expect(response.validation).toMatchObject({
      badge: "green",
      manifold: true,
      components: 1,
      volume_mm3: 35 * 35 * 35,
      warning_count: 0
    });
  }, 60_000);

  it("revert restores rendered, validated geometry into a new snapshot without changing the source snapshot", async () => {
    const { runtime, dir } = await seedProject();
    const rest = createScadCoreApi(runtime);
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    const validation = await agentCore.validateMesh({});
    const render = await agentCore.renderViews({ views: ["iso"] });
    expect(render.ok).toBe(true);

    const sourceHistoryBefore = await checksumSnapshotDir(dir, "0001");
    const sourceRenderBefore = Buffer.from((await rest.getSnapshotRenderFile("bracket", "0001", "iso"))!.data);
    const sourceMeshBefore = Buffer.from((await rest.getSnapshotMeshFile("bracket", "0001"))!.data);
    const sourceValidationPath = (await resolveSnapshotValidationPath(dir, "0001"))!;
    const sourceValidationBefore = await readFile(sourceValidationPath);

    const edited = await agentCore.writeScad({
      content: "size = 25; // [5:50]\ncube([size, size, size]);\n",
      message: "Edited after rendered source",
      pass: 1
    });
    expect(edited.snapshot).not.toBeNull();
    expect(edited.snapshot!.id).toBe("0002");

    const reverted = await rest.revertSnapshot("bracket", "0001", {});
    expect(reverted.snapshot.id).toBe("0003");
    expect(reverted.snapshot.origin).toBe("revert");
    expect(reverted.snapshot.validation?.volume_mm3).toBeCloseTo(validation.report.volume_mm3!, 1);
    expect(reverted.snapshot.renders).toEqual([
      expect.objectContaining({ view: "iso", url: expect.stringContaining("/snapshots/0003/") })
    ]);

    const restoredRender = await rest.getSnapshotRenderFile("bracket", "0003", "iso");
    const restoredMesh = await rest.getSnapshotMeshFile("bracket", "0003");
    const restoredValidationPath = (await resolveSnapshotValidationPath(dir, "0003"))!;
    expect(Buffer.from(restoredRender!.data)).toEqual(sourceRenderBefore);
    expect(Buffer.from(restoredMesh!.data)).toEqual(sourceMeshBefore);
    expect(await readFile(restoredValidationPath)).toEqual(sourceValidationBefore);

    expect(await checksumSnapshotDir(dir, "0001")).toEqual(sourceHistoryBefore);
    expect(Buffer.from((await rest.getSnapshotRenderFile("bracket", "0001", "iso"))!.data)).toEqual(
      sourceRenderBefore
    );
    expect(Buffer.from((await rest.getSnapshotMeshFile("bracket", "0001"))!.data)).toEqual(sourceMeshBefore);
    expect(await readFile(sourceValidationPath)).toEqual(sourceValidationBefore);
  }, 180_000);

  it("re-validating (and rendering) the current head after an UNSNAPSHOTTED params change still describes the HEAD SNAPSHOT'S OWN persisted params, not the project's current root state", async () => {
    const { runtime, dir } = await seedProject();
    const rest = createScadCoreApi(runtime);
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    // Snapshot 0002: size=30, persisted both to its own history/0002/params.json
    // and (at the time) to root params.json.
    const setOutcome = await agentCore.setParams({ size: 30 }, 0);
    expect(setOutcome.snapshot?.id).toBe("0002");

    // Diverge the CURRENT root params.json from 0002's own persisted params,
    // WITHOUT creating a new snapshot -- `snapshot:false` is the one legitimate
    // way "current project state" and "head snapshot's own state" can differ.
    await rest.updateParams("bracket", { values: { size: 45 }, snapshot: false });
    expect((await rest.getParams("bracket")).values).toEqual({ size: 45 });

    // No explicit override -> must validate/render 0002's OWN size=30, never
    // root's size=45 and never the .scad source's literal default (size=20).
    const validation = await agentCore.validateMesh({});
    expect(validation.report.volume_mm3).toBeCloseTo(30 * 30 * 30, 1);

    const render = await agentCore.renderViews({ views: ["iso"] });
    expect(render.ok).toBe(true);

    // The result was attached to snapshot 0002 (the pinned head at call
    // time), and 0002's OWN persisted params are untouched (still size=30).
    const snap2 = await readSnapshotManifest(dir, "0002");
    expect(snap2.validation?.volume_mm3).toBeCloseTo(30 * 30 * 30, 1);
    expect(snap2.params).toEqual({ size: 30 });
    expect(snap2.renders.map((r) => r.view)).toContain("iso");

    // And snapshot 0001 (a DIFFERENT, non-head snapshot) was never touched at
    // all by any of this.
    const snap1 = await readSnapshotManifest(dir, "0001");
    expect(snap1.validation).toBeNull();
    expect(snap1.renders).toEqual([]);
  }, 120_000);

  it("validating/rendering the head snapshot never mutates a DIFFERENT (older) snapshot's directory", async () => {
    const { runtime, dir } = await seedProject();
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    // A second, different snapshot -- 0001 is now history, 0002 is head.
    await agentCore.writeScad({ content: "size = 25; // [5:50]\ncube([size, size, size]);\n", message: "bigger", pass: 0 });

    const before0001 = await checksumSnapshotDir(dir, "0001");
    await agentCore.validateMesh({});
    await agentCore.renderViews({ views: ["iso"] });
    const after0001 = await checksumSnapshotDir(dir, "0001");

    expect(after0001).toEqual(before0001);
  }, 120_000);

  it("an explicit params OVERRIDE is a preview: returned to the caller but never attached to any snapshot's history", async () => {
    const { runtime, dir } = await seedProject();
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    const before = await checksumSnapshotDir(dir, "0001");
    const preview = await agentCore.validateMesh({ params: { size: 49 } });
    expect(preview.report.volume_mm3).toBeCloseTo(49 * 49 * 49, 1);
    const after = await checksumSnapshotDir(dir, "0001");

    expect(after).toEqual(before);
    const snap1 = await readSnapshotManifest(dir, "0001");
    // The preview's size=49 result must NOT have been recorded against 0001
    // (whose own params are `{}`, i.e. the source's own size=20 default).
    expect(snap1.validation).toBeNull();
  }, 60_000);

  // ── Legacy fallback (post-review follow-up) ────────────────────────────
  //
  // A project created by the PRE-FIX code (like the owner's real demo
  // project) has renders/validation physically INSIDE `history/<id>/views/`
  // and `history/<id>/validation.json` -- there is no `derived/<id>/` tree.
  // Serving those must still work (read-time fallback), and a NEW render/
  // validate on that same legacy project must land in `derived/`, never
  // touch the legacy `history/<id>/` bytes.
  const LEGACY_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  async function seedLegacySnapshot(dir: string, id: string): Promise<void> {
    const historyDir = snapshotDir(dir, id);
    const viewsDir = join(historyDir, PROJECT_LAYOUT.snapshot.viewsDir);
    await mkdir(viewsDir, { recursive: true });
    await writeFile(join(viewsDir, "iso.png"), LEGACY_PNG);
    await writeFile(
      join(historyDir, PROJECT_LAYOUT.snapshot.validationFile),
      JSON.stringify({ manifold: true, status: "NoError", volume_mm3: 8000, surface_area: 2400, bbox: { min: [0, 0, 0], max: [20, 20, 20] }, triangle_count: 12, components: 1, genus: 0 }, null, 2),
      "utf8"
    );
    const manifestPath = join(historyDir, PROJECT_LAYOUT.snapshot.manifestFile);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
    manifest.renders = [
      { view: "iso", file: "views/iso.png", url: "/api/legacy/iso.png", width: 1024, height: 768, bytes: LEGACY_PNG.byteLength, render_ms: 500 }
    ];
    manifest.validation = { badge: "green", manifold: true, components: 1, volume_mm3: 8000, warning_count: 0 };
    manifest.files = { ...manifest.files, validation_json: PROJECT_LAYOUT.snapshot.validationFile };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  it("serves a LEGACY project's pre-existing render (no derived/ tree) via getSnapshotRenderFile, never 404s", async () => {
    const { runtime, dir } = await seedProject();
    await seedLegacySnapshot(dir, "0001");

    const rest = createScadCoreApi(runtime);
    const file = await rest.getSnapshotRenderFile("bracket", "0001", "iso");
    expect(file).not.toBeNull();
    expect(Buffer.from(file!.data)).toEqual(LEGACY_PNG);
  });

  it("a NEW render/validate on a LEGACY-shaped project lands in derived/ and leaves the pre-existing history/<id>/ bytes untouched", async () => {
    const { runtime, dir } = await seedProject();
    await seedLegacySnapshot(dir, "0001");

    const legacyPngBefore = await readFile(join(snapshotDir(dir, "0001"), PROJECT_LAYOUT.snapshot.viewsDir, "iso.png"));
    const legacyValidationBefore = await readFile(join(snapshotDir(dir, "0001"), PROJECT_LAYOUT.snapshot.validationFile), "utf8");
    const manifestBefore = await readFile(join(snapshotDir(dir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile), "utf8");

    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });
    // Real render/validate against the SAME (legacy) head snapshot.
    const validation = await agentCore.validateMesh({});
    expect(validation.report.volume_mm3).toBeCloseTo(20 * 20 * 20, 1);
    await agentCore.renderViews({ views: ["front"] });

    // The pre-existing legacy bytes are untouched -- proves write-once holds
    // even starting from a legacy (pre-fix-created) snapshot, not just a
    // fresh one.
    expect(await readFile(join(snapshotDir(dir, "0001"), PROJECT_LAYOUT.snapshot.viewsDir, "iso.png"))).toEqual(
      legacyPngBefore
    );
    expect(await readFile(join(snapshotDir(dir, "0001"), PROJECT_LAYOUT.snapshot.validationFile), "utf8")).toBe(
      legacyValidationBefore
    );
    expect(await readFile(join(snapshotDir(dir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile), "utf8")).toBe(
      manifestBefore
    );

    // The manifest now reports the NEW validation (derived/ wins over the
    // legacy embedded value once a fresh attach has happened), and BOTH the
    // legacy 'iso' render and the newly-attached 'front' render resolve.
    const manifest = await readSnapshotManifest(dir, "0001");
    expect(manifest.validation?.volume_mm3).toBeCloseTo(20 * 20 * 20, 1);
    expect(manifest.renders.map((r) => r.view).sort()).toEqual(["front", "iso"]);

    const rest = createScadCoreApi(runtime);
    const legacyFile = await rest.getSnapshotRenderFile("bracket", "0001", "iso"); // still legacy, untouched
    expect(Buffer.from(legacyFile!.data)).toEqual(LEGACY_PNG);
    const freshFile = await rest.getSnapshotRenderFile("bracket", "0001", "front"); // new, from derived/
    expect(freshFile).not.toBeNull();
    expect(freshFile!.bytes).toBeGreaterThan(0);
  }, 60_000);

  // ── Mesh persistence, reconciled with Issue #41 (PR #50) ─────────────────
  //
  // #50 persisted the validation mesh at `history/<id>/mesh.stl`, rendered
  // from `rootModelPath(dir)` -- the exact #45 defect, re-created for meshes.
  // Reconciled: the mesh is a DERIVED artifact (`derived/<id>/mesh.stl`),
  // rendered from the PINNED snapshot's own staged model/params, in the SAME
  // container invocation `validate_mesh` already pays for (no second render).

  it("the persisted mesh reflects the HEAD SNAPSHOT'S OWN geometry after an unsnapshotted params divergence, and history/ stays byte-identical", async () => {
    const { runtime, dir } = await seedProject(); // snapshot 0001: params {} -> the .scad source's own literal default, size=20
    const rest = createScadCoreApi(runtime);
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    // Diverge the CURRENT root params from 0001's own (still `{}`) WITHOUT
    // creating a new snapshot -- the one legitimate way root and head-
    // snapshot state can differ (see the UNSNAPSHOTTED test above).
    await rest.updateParams("bracket", { values: { size: 45 }, snapshot: false });
    expect((await rest.getParams("bracket")).values).toEqual({ size: 45 });

    const before = await checksumSnapshotDir(dir, "0001");
    // No override -> validates (and persists a mesh for) 0001's OWN size=20,
    // never root's diverged size=45.
    const validation = await agentCore.validateMesh({});
    const after = await checksumSnapshotDir(dir, "0001");
    // Persisting a mesh must not touch a single byte of history/0001/ -- it
    // is a NEW file in derived/, exactly like a render or validation.json.
    expect(after).toEqual(before);

    const meshFile = await rest.getSnapshotMeshFile("bracket", "0001");
    expect(meshFile).not.toBeNull();
    const triangles = parseStl(Buffer.from(meshFile!.data));

    // Structural check (the one #50's own QA used): the served bytes are
    // exactly the mesh that was validated, not a different render or a
    // truncated copy.
    expect(triangles.length).toBe(validation.report.triangle_count);

    // Geometric check: the mesh's own bounding box reflects size=20 (0001's
    // OWN persisted params), never size=45 (root's diverged, unsnapshotted
    // value) and never some other stale render.
    const maxCoord = Math.max(...triangles.flatMap((t) => t.flatMap((v) => v)));
    expect(maxCoord).toBeCloseTo(20, 1);
    expect(maxCoord).not.toBeCloseTo(45, 1);
  }, 60_000);

  it("a preview validation (explicit params override) never persists a mesh for any snapshot", async () => {
    const { runtime, dir } = await seedProject();
    const rest = createScadCoreApi(runtime);
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });

    const before = await checksumSnapshotDir(dir, "0001");
    await agentCore.validateMesh({ params: { size: 49 } });
    const after = await checksumSnapshotDir(dir, "0001");
    expect(after).toEqual(before);

    const meshFile = await rest.getSnapshotMeshFile("bracket", "0001");
    expect(meshFile).toBeNull();
  }, 60_000);

  // ── Editor sidecar capture, S3-B B3 (Issue #87) ───────────────────────────
  //
  // `history/<id>/editor.json` is written ONCE, at snapshot creation, exactly
  // like `manifest.json`/`model.scad`/`params.json` -- every test above
  // already proves this incidentally (`checksumSnapshotDir` walks the WHOLE
  // `history/<id>/` directory, `editor.json` included), but this test names
  // it explicitly and additionally proves the COPY-FORWARD correctness of a
  // real revert (the reverted snapshot's own captured copy, not a rewrite of
  // the source's).

  it("history/<id>/editor.json is written once at snapshot creation and stays byte-identical through validate/render/export/revert", async () => {
    const { runtime, dir } = await seedProject();
    const agentCore = createAgentScadCore({ runtime, projectId: "bracket" });
    const rest = createScadCoreApi(runtime);

    const snap1 = await readSnapshotManifest(dir, "0001");
    expect(snap1.editor).toEqual({ version: 1, file: "editor.json", sha256: sidecarDigest(EMPTY_SIDECAR) });
    const editorJsonPath = (id: string) => join(snapshotDir(dir, id), "editor.json");
    const before = await readFile(editorJsonPath("0001"));

    await agentCore.validateMesh({});
    await agentCore.renderViews({ views: ["iso"] });
    await rest.runExport("bracket", { format: "stl" });
    expect(await readFile(editorJsonPath("0001"))).toEqual(before);

    const reverted = await rest.revertSnapshot("bracket", "0001", {});
    // 0001 -- the REVERT SOURCE -- is untouched by its own revert.
    expect(await readFile(editorJsonPath("0001"))).toEqual(before);
    // The REVERTED snapshot captured its OWN copy-forward from 0001's own
    // captured editor.json -- byte-identical, never a re-derivation.
    expect(await readFile(editorJsonPath(reverted.snapshot.id))).toEqual(before);
    expect(reverted.snapshot.editor).toEqual(snap1.editor);
  }, 120_000);
});
