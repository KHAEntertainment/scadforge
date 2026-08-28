import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
