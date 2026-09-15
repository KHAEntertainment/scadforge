// SPDX-License-Identifier: Apache-2.0
//
// @docker -- Issue #32's headline AC: a REAL render whose resulting mesh
// geometry (bbox / volume) actually changes when a Customizer parameter
// changes -- not merely that the render command ran. Also the AC's
// round-trip: parser (#30) -> schema -> set value -> render -> bbox reflects
// the change, exercised end to end against the pinned OpenSCAD image.
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseParamSchema } from "../params/parse.js";
import { dockerAvailable, fixture } from "../test-support/docker-available.js";
import { validateModel } from "./validate-model.js";

describe.skipIf(!dockerAvailable())("@docker validateModel params override (real pinned OpenSCAD image)", () => {
  it("round-trips: parsed schema -> set a new value -> render -> bbox/volume reflect it", async () => {
    const scadPath = fixture("simple.scad");
    const source = await readFile(scadPath, "utf8");

    // 1. parser (#30): the fixture declares one Customizer parameter, `size`.
    const schema = parseParamSchema(source);
    const sizeParam = schema.parameters.find((p) => p.name === "size");
    expect(sizeParam).toBeDefined();
    expect(sizeParam?.initial).toBe(20);

    // 2. set a new value within the parsed [min:max] bounds.
    const overrideSize = 40;
    expect(overrideSize).not.toBe(sizeParam?.initial);
    expect(overrideSize).toBeLessThanOrEqual(sizeParam?.max ?? Infinity);
    expect(overrideSize).toBeGreaterThanOrEqual(sizeParam?.min ?? -Infinity);

    // 3. render (via the same params-override pipe `render_views`/`export` use).
    const baseline = await validateModel(scadPath, { params: { size: sizeParam!.initial as number } });
    const overridden = await validateModel(scadPath, { params: { size: overrideSize } });

    // 4. the resulting mesh actually changed shape -- assert on bbox/volume,
    // not just that the command exited successfully.
    expect(baseline.report.manifold).toBe(true);
    expect(overridden.report.manifold).toBe(true);
    expect(overridden.report.volume_mm3).not.toBeNull();
    expect(baseline.report.volume_mm3).not.toBeNull();
    expect(overridden.report.volume_mm3!).toBeGreaterThan(baseline.report.volume_mm3!);
    // A cube of side `size`: volume scales with size^3.
    expect(overridden.report.volume_mm3!).toBeCloseTo(overrideSize ** 3, 0);
    expect(baseline.report.volume_mm3!).toBeCloseTo((sizeParam!.initial as number) ** 3, 0);

    expect(overridden.report.bbox).not.toBeNull();
    expect(baseline.report.bbox).not.toBeNull();
    expect(overridden.report.bbox!.max[0]).toBeGreaterThan(baseline.report.bbox!.max[0]);
    expect(overridden.report.bbox!.max).toEqual([overrideSize, overrideSize, overrideSize]);
  }, 60_000);

  // COUNTEREXAMPLE: an override for a param the model doesn't declare must not
  // silently change geometry or crash the render -- OpenSCAD itself ignores an
  // unknown preset key, so the mesh must match the UN-overridden baseline.
  it("an override naming a parameter the model does not declare leaves the geometry unchanged", async () => {
    const scadPath = fixture("simple.scad");
    const baseline = await validateModel(scadPath, {});
    const withBogusOverride = await validateModel(scadPath, { params: { not_a_real_param: 999 } });
    expect(withBogusOverride.report.volume_mm3).toEqual(baseline.report.volume_mm3);
  }, 60_000);
});

// ── mesh persistence (Issue #41) ─────────────────────────────────────────────
//
// The demo's 3D preview was blank in part because this function rendered a
// binary STL for manifold-3d and then deleted it with the work directory, so
// no `.stl` existed anywhere in a project tree. `persistMeshTo` keeps that
// SAME render — the point being that no second render pass is added.
describe.skipIf(!dockerAvailable())("@docker validateModel mesh persistence (Issue #41)", () => {
  it("keeps the validation STL at persistMeshTo, and it is the mesh that was validated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scadforge-mesh-persist-"));
    try {
      // A nested destination, since the real caller aims at a snapshot
      // directory that may not have been created yet.
      const dest = join(dir, "history", "0002", "mesh.stl");
      const result = await validateModel(fixture("simple.scad"), { params: { size: 20 }, persistMeshTo: dest });

      const bytes = await readFile(dest);
      expect(bytes.byteLength).toBeGreaterThan(0);

      // Binary STL: an 80-byte header, then a uint32 triangle count, then 50
      // bytes per triangle. Checking the count against the report proves the
      // persisted file is the very mesh that was validated, not some other
      // render or a truncated copy.
      expect(bytes.byteLength).toBe(84 + 50 * result.report.triangle_count);
      expect(bytes.readUInt32LE(80)).toBe(result.report.triangle_count);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("writes no stray temp file beside the mesh, so the snapshot directory stays clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scadforge-mesh-persist-"));
    try {
      await validateModel(fixture("simple.scad"), { persistMeshTo: join(dir, "mesh.stl") });
      // The copy goes via `mesh.stl.tmp` + rename so a reader never sees a
      // half-written STL; the temp name must not survive the rename.
      expect((await readdir(dir)).sort()).toEqual(["mesh.stl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("counterexample: an unwritable destination is swallowed — validation still returns its verdict", async () => {
    // Persisting is bookkeeping for the UI. A model the user paid to render
    // and validate must still report its result even if the mesh cannot be
    // stored (read-only volume, full disk, a path that is not a directory).
    const dir = await mkdtemp(join(tmpdir(), "scadforge-mesh-persist-"));
    try {
      const blocker = join(dir, "blocker");
      await writeFile(blocker, "not a directory");
      const result = await validateModel(fixture("simple.scad"), {
        persistMeshTo: join(blocker, "nested", "mesh.stl")
      });
      expect(result.report.manifold).toBe(true);
      expect(result.gate.badge).toBe("green");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
