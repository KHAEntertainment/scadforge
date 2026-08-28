import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import type { SnapshotManifest } from "@scadforge/protocol";
import { initProject, readSnapshotManifest } from "./store.js";
import { snapshotDir } from "./paths.js";
import {
  attachRendersToSnapshot,
  attachValidationToSnapshot,
  resolveSnapshotMeshPath,
  resolveSnapshotRenderPath,
  resolveSnapshotValidationPath,
  snapshotMeshPath,
  snapshotRenderPath,
  snapshotValidationPath,
  snapshotViewsDir
} from "./attachments.js";
import type { ValidationResult } from "../types.js";

let projectDir: string;
let pngPath: string;

const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

// A minimal but genuinely PNG-shaped payload — the attacher only copies bytes
// and stats the result, so the contents only need to be stable and non-empty.
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-renders-test-"));
  pngPath = join(projectDir, "iso-source.png");
  await writeFile(pngPath, PNG_BYTES);
  await initProject(projectDir, {
    id: "bracket",
    name: "Bracket",
    provider: providerConfig,
    content: "cube([10,10,10]);\n"
  });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** Reads `history/<id>/manifest.json` RAW off disk -- bypassing `readSnapshotManifest`'s derived merge, so these assertions prove the file itself is untouched (Issue #45 AC2). */
async function readRawHistoryManifest(id: string): Promise<SnapshotManifest> {
  const raw = await readFile(join(snapshotDir(projectDir, id), PROJECT_LAYOUT.snapshot.manifestFile), "utf8");
  return JSON.parse(raw) as SnapshotManifest;
}

describe("attachRendersToSnapshot", () => {
  it("copies the PNG into the snapshot's DERIVED views/ dir and records a RenderRef, WITHOUT touching history/<id>/manifest.json", async () => {
    const rawBefore = await readRawHistoryManifest("0001");

    const manifest = await attachRendersToSnapshot(projectDir, "0001", [
      { view: "iso", sourcePath: pngPath, render_ms: 42, width: 1024, height: 768 }
    ]);

    expect(manifest.renders).toHaveLength(1);
    expect(manifest.renders[0]).toMatchObject({
      view: "iso",
      file: "views/iso.png",
      width: 1024,
      height: 768,
      bytes: PNG_BYTES.byteLength,
      render_ms: 42
    });
    await expect(readFile(snapshotRenderPath(projectDir, "0001", "iso"))).resolves.toEqual(PNG_BYTES);

    // Reads through the real store surface (what every consumer actually
    // calls) see the enrichment merged in...
    expect((await readSnapshotManifest(projectDir, "0001")).renders).toHaveLength(1);
    // ...but the RAW `history/0001/manifest.json` file on disk is byte-for-byte
    // unchanged -- this is the enforced-in-code guarantee AC2 requires, not a
    // convention.
    expect(await readRawHistoryManifest("0001")).toEqual(rawBefore);
    // And its own `views/` directory (created empty at snapshot creation) has
    // no PNG in it -- the file physically lives under `derived/`.
    await expect(
      readFile(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.viewsDir, "iso.png"))
    ).rejects.toThrow();
  });

  it("uses the caller's URL builder, and falls back to a bare relative path without one", async () => {
    const withBuilder = await attachRendersToSnapshot(
      projectDir,
      "0001",
      [{ view: "front", sourcePath: pngPath, render_ms: null, width: 800, height: 600 }],
      { buildRenderUrl: (id, view) => `/api/projects/bracket/snapshots/${id}/views/${view}` }
    );
    expect(withBuilder.renders[0].url).toBe("/api/projects/bracket/snapshots/0001/views/front");

    const withoutBuilder = await attachRendersToSnapshot(projectDir, "0001", [
      { view: "top", sourcePath: pngPath, render_ms: null, width: 800, height: 600 }
    ]);
    expect(withoutBuilder.renders.find((r) => r.view === "top")?.url).toBe("/views/top.png");
  });

  it("replaces an already-attached view instead of duplicating it", async () => {
    await attachRendersToSnapshot(projectDir, "0001", [
      { view: "iso", sourcePath: pngPath, render_ms: 10, width: 1024, height: 768 }
    ]);
    const second = await attachRendersToSnapshot(projectDir, "0001", [
      { view: "iso", sourcePath: pngPath, render_ms: 99, width: 640, height: 480 }
    ]);

    expect(second.renders.filter((r) => r.view === "iso")).toHaveLength(1);
    expect(second.renders[0]).toMatchObject({ render_ms: 99, width: 640, height: 480 });
    // A second attach for the SAME view still never touches history/.
    expect((await readRawHistoryManifest("0001")).renders).toEqual([]);
  });

  it("leaves the model timeline untouched (append-only history is not violated)", async () => {
    const before = await readRawHistoryManifest("0001");
    await attachRendersToSnapshot(projectDir, "0001", [
      { view: "iso", sourcePath: pngPath, render_ms: 5, width: 1024, height: 768 }
    ]);
    const after = await readRawHistoryManifest("0001");

    expect(after).toEqual(before);
    await expect(
      readFile(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.modelFile), "utf8")
    ).resolves.toBe("cube([10,10,10]);\n");
  });

  it("fails with a typed SNAPSHOT_NOT_FOUND rather than a raw fs error", async () => {
    await expect(
      attachRendersToSnapshot(projectDir, "9999", [
        { view: "iso", sourcePath: pngPath, render_ms: null, width: 1, height: 1 }
      ])
    ).rejects.toMatchObject({ error_code: "SNAPSHOT_NOT_FOUND" });
  });

  it("is a no-op on the manifest when given no attachments", async () => {
    const manifest = await attachRendersToSnapshot(projectDir, "0001", []);
    expect(manifest.renders).toEqual([]);
  });

  it("derives the DERIVED views/ directory, not history/<id>/views/", () => {
    expect(snapshotViewsDir(projectDir, "0002")).toBe(
      join(projectDir, PROJECT_LAYOUT.metaDir, "derived", "0002", "views")
    );
  });
});

const GREEN_VALIDATION: ValidationResult = {
  report: {
    manifold: true,
    status: "NoError",
    volume_mm3: 12345.6789,
    surface_area: 4321.1,
    bbox: { min: [0, 0, 0], max: [40, 20, 10] },
    triangle_count: 512,
    components: 1,
    genus: 0
  },
  gate: { ok: true, badge: "green", failures: [], warnings: [] },
  export_ms: 1200,
  validate_ms: 30
};

describe("attachValidationToSnapshot", () => {
  it("persists the full report verbatim to the DERIVED location and summarises it into the read-merged manifest, WITHOUT touching history/<id>/validation.json or manifest.json", async () => {
    const rawBefore = await readRawHistoryManifest("0001");

    const manifest = await attachValidationToSnapshot(projectDir, "0001", GREEN_VALIDATION);

    expect(manifest.validation).toEqual({
      badge: "green",
      manifold: true,
      components: 1,
      volume_mm3: 12345.6789,
      warning_count: 0
    });
    expect(manifest.files.validation_json).toBe(PROJECT_LAYOUT.snapshot.validationFile);

    const persisted = JSON.parse(await readFile(snapshotValidationPath(projectDir, "0001"), "utf8"));
    expect(persisted).toEqual(GREEN_VALIDATION.report);
    expect((await readSnapshotManifest(projectDir, "0001")).validation?.manifold).toBe(true);

    // The raw file on disk never changed.
    expect(await readRawHistoryManifest("0001")).toEqual(rawBefore);
    await expect(
      readFile(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.validationFile), "utf8")
    ).rejects.toThrow();
  });

  it("records a red gate and its warning count without discarding the report", async () => {
    const red: ValidationResult = {
      report: { ...GREEN_VALIDATION.report, manifold: false, status: "NotManifold", components: null, volume_mm3: null },
      gate: {
        ok: false,
        badge: "red",
        failures: [{ code: "NOT_MANIFOLD", message: "the mesh is not manifold" }],
        warnings: ["nonzero genus"]
      },
      export_ms: null,
      validate_ms: 12
    };
    const manifest = await attachValidationToSnapshot(projectDir, "0001", red);
    expect(manifest.validation).toMatchObject({ badge: "red", manifold: false, components: null, warning_count: 1 });
  });

  it("re-validating replaces the previous verdict rather than appending, still never touching history/", async () => {
    await attachValidationToSnapshot(projectDir, "0001", GREEN_VALIDATION);
    const rawAfterFirst = await readRawHistoryManifest("0001");
    const second = await attachValidationToSnapshot(projectDir, "0001", {
      ...GREEN_VALIDATION,
      gate: { ...GREEN_VALIDATION.gate, badge: "amber", warnings: ["multi-part allowed by override"] }
    });
    expect(second.validation?.badge).toBe("amber");
    expect(second.validation?.warning_count).toBe(1);
    expect(await readRawHistoryManifest("0001")).toEqual(rawAfterFirst);
  });

  it("leaves the model timeline untouched", async () => {
    const before = await readRawHistoryManifest("0001");
    await attachValidationToSnapshot(projectDir, "0001", GREEN_VALIDATION);
    const after = await readRawHistoryManifest("0001");
    expect(after).toEqual(before);
  });

  it("fails with a typed SNAPSHOT_NOT_FOUND on an unknown snapshot", async () => {
    await expect(attachValidationToSnapshot(projectDir, "9999", GREEN_VALIDATION)).rejects.toMatchObject({
      error_code: "SNAPSHOT_NOT_FOUND"
    });
  });
});

// ── Legacy fallback (post-review follow-up on Issue #45) ────────────────────
//
// A project created by the PRE-FIX code has its renders/validation.json
// physically INSIDE `history/<id>/views/` and `history/<id>/validation.json`
// -- there is no `derived/<id>/` tree at all for it. `resolveSnapshotRenderPath`
// / `resolveSnapshotValidationPath` must still find those files (read-time
// fallback), and doing so must NEVER write into `history/` (no migration).
describe("legacy fallback: reading a snapshot that predates the derived/ tree", () => {
  const LEGACY_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const LEGACY_VALIDATION = {
    manifold: true,
    status: "NoError",
    volume_mm3: 999,
    surface_area: 100,
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    triangle_count: 12,
    components: 1,
    genus: 0
  };

  /** Hand-writes a legacy-shaped snapshot: renders/validation baked straight into `history/<id>/`, exactly what the pre-fix `attachRendersToSnapshot`/`attachValidationToSnapshot` produced, and NO `derived/<id>/` tree. */
  async function seedLegacySnapshot(id: string): Promise<void> {
    const dir = snapshotDir(projectDir, id);
    const viewsDir = join(dir, PROJECT_LAYOUT.snapshot.viewsDir);
    await mkdir(viewsDir, { recursive: true });
    await writeFile(join(viewsDir, "iso.png"), LEGACY_PNG);
    await writeFile(join(dir, PROJECT_LAYOUT.snapshot.validationFile), JSON.stringify(LEGACY_VALIDATION, null, 2), "utf8");

    const manifestPath = join(dir, PROJECT_LAYOUT.snapshot.manifestFile);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
    manifest.renders = [
      { view: "iso", file: "views/iso.png", url: "/views/iso.png", width: 1024, height: 768, bytes: LEGACY_PNG.byteLength, render_ms: 42 }
    ];
    manifest.validation = { badge: "green", manifold: true, components: 1, volume_mm3: 999, warning_count: 0 };
    manifest.files = { ...manifest.files, validation_json: PROJECT_LAYOUT.snapshot.validationFile };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  it("resolveSnapshotRenderPath falls back to history/<id>/views/ when no derived/ tree exists", async () => {
    await seedLegacySnapshot("0001");
    const resolved = await resolveSnapshotRenderPath(projectDir, "0001", "iso");
    expect(resolved).toBe(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.viewsDir, "iso.png"));
    await expect(readFile(resolved!)).resolves.toEqual(LEGACY_PNG);
  });

  it("resolveSnapshotValidationPath falls back to history/<id>/validation.json when no derived/ tree exists", async () => {
    await seedLegacySnapshot("0001");
    const resolved = await resolveSnapshotValidationPath(projectDir, "0001");
    expect(resolved).toBe(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.validationFile));
    const persisted = JSON.parse(await readFile(resolved!, "utf8"));
    expect(persisted).toEqual(LEGACY_VALIDATION);
  });

  it("prefers the DERIVED location over the legacy one once a fresh attach has happened", async () => {
    await seedLegacySnapshot("0001");
    // A fresh re-render lands in derived/, not history/.
    await attachRendersToSnapshot(projectDir, "0001", [
      { view: "iso", sourcePath: pngPath, render_ms: 7, width: 640, height: 480 }
    ]);
    const resolved = await resolveSnapshotRenderPath(projectDir, "0001", "iso");
    expect(resolved).toBe(snapshotRenderPath(projectDir, "0001", "iso"));
    await expect(readFile(resolved!)).resolves.toEqual(PNG_BYTES); // the FRESH bytes, not the legacy ones
  });

  it("returns null (never throws) when the render/validation exists in neither location", async () => {
    // `beforeEach` already created snapshot 0001 (via `initProject`) with no
    // renders/validation attached at all -- neither derived/ nor history/
    // has anything for it.
    expect(await resolveSnapshotRenderPath(projectDir, "0001", "front")).toBeNull();
    expect(await resolveSnapshotValidationPath(projectDir, "0001")).toBeNull();
  });

  it("reading via the fallback never writes into history/ -- the legacy snapshot's directory stays byte-identical", async () => {
    await seedLegacySnapshot("0001");
    const before = await readFile(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile), "utf8");
    await resolveSnapshotRenderPath(projectDir, "0001", "iso");
    await resolveSnapshotValidationPath(projectDir, "0001");
    // Read through the real store surface too (what `apps/server` actually calls).
    const manifest = await readSnapshotManifest(projectDir, "0001");
    expect(manifest.renders).toHaveLength(1);
    expect(manifest.validation?.volume_mm3).toBe(999);
    const after = await readFile(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile), "utf8");
    expect(after).toBe(before);
  });
});

// ── Legacy mesh fallback (Issue #41/#45 reconciliation) ─────────────────────
//
// PR #50 (Issue #41, merged before this reconciliation landed) persisted a
// snapshot's validation mesh directly at `history/<id>/mesh.stl`. A project
// validated in that window has its mesh there, with no `derived/<id>/` tree
// for it at all -- `resolveSnapshotMeshPath` must still find it, read-only,
// never migrating the file forward.
describe("legacy mesh fallback: reading a mesh persisted by pre-reconciliation #50 code", () => {
  const LEGACY_MESH = Buffer.from("legacy binary stl bytes, stand-in only");

  async function seedLegacyMesh(id: string): Promise<void> {
    await writeFile(join(snapshotDir(projectDir, id), "mesh.stl"), LEGACY_MESH);
  }

  it("resolveSnapshotMeshPath falls back to history/<id>/mesh.stl when no derived/ tree exists", async () => {
    await seedLegacyMesh("0001");
    const resolved = await resolveSnapshotMeshPath(projectDir, "0001");
    expect(resolved).toBe(join(snapshotDir(projectDir, "0001"), "mesh.stl"));
    await expect(readFile(resolved!)).resolves.toEqual(LEGACY_MESH);
  });

  it("prefers the DERIVED mesh once one has been written there", async () => {
    await seedLegacyMesh("0001");
    const derivedPath = snapshotMeshPath(projectDir, "0001"); // the WRITE-time (derived) location
    const FRESH_MESH = Buffer.from("fresh derived mesh bytes");
    await mkdir(join(derivedPath, ".."), { recursive: true });
    await writeFile(derivedPath, FRESH_MESH);

    const resolved = await resolveSnapshotMeshPath(projectDir, "0001");
    expect(resolved).toBe(derivedPath);
    await expect(readFile(resolved!)).resolves.toEqual(FRESH_MESH);
  });

  it("returns null (never throws) when no mesh exists in either location", async () => {
    expect(await resolveSnapshotMeshPath(projectDir, "0001")).toBeNull();
  });

  it("never writes into history/ -- the legacy snapshot's mesh.stl and manifest stay byte-identical after resolving", async () => {
    await seedLegacyMesh("0001");
    const meshBefore = await readFile(join(snapshotDir(projectDir, "0001"), "mesh.stl"));
    const manifestBefore = await readFile(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile), "utf8");

    await resolveSnapshotMeshPath(projectDir, "0001");

    expect(await readFile(join(snapshotDir(projectDir, "0001"), "mesh.stl"))).toEqual(meshBefore);
    expect(await readFile(join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.manifestFile), "utf8")).toBe(
      manifestBefore
    );
  });
});
