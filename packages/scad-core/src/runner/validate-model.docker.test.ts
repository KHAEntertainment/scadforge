// @docker -- Issue #32's headline AC: a REAL render whose resulting mesh
// geometry (bbox / volume) actually changes when a Customizer parameter
// changes -- not merely that the render command ran. Also the AC's
// round-trip: parser (#30) -> schema -> set value -> render -> bbox reflects
// the change, exercised end to end against the pinned OpenSCAD image.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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
