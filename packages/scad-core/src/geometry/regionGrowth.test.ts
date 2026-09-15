// @scadforge/scad-core — regionGrowth.ts tests (Issue #91, S3-B ticket B5).
//
// cylinderFit.test.ts already proves the circle-fit math on raw
// vertex/normal lists; these tests prove the region-growth WIRING —
// axis selection, adjacency-walk growth, and the coarse-polygon-or-planar
// probe — on real triangulated/welded meshes, since that connectivity is
// exactly what's new here (surfaceRegion.test.ts covers the same wiring via
// three.js `BufferGeometry`; this covers it via the geometry module's own
// `WeldedMesh`, which the B5 proof service builds from a rendered STL).
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Axis } from "./vec.js";
import { growRegion, principalAxisOf, recognizeRegion, selectAxis } from "./regionGrowth.js";
import { buildFlatQuadMesh, buildTubeMesh } from "./testMeshFixtures.js";

describe("selectAxis", () => {
  it("selects the axis a radial normal is perpendicular to (that axis's own component near zero, the other two not)", () => {
    expect(selectAxis({ x: 0, y: 0.6, z: 0.8 })).toEqual({ kind: "axis", axis: "x" });
    expect(selectAxis({ x: 0.6, y: 0, z: 0.8 })).toEqual({ kind: "axis", axis: "y" });
  });

  it("classifies a normal dominated by one axis (both others near zero) as planar", () => {
    expect(selectAxis({ x: 0, y: 0, z: 1 })).toEqual({ kind: "planar" });
  });

  it("classifies a normal with no near-zero component (a genuine cone/tilt) as not-axis-aligned", () => {
    const third = 1 / Math.sqrt(3);
    expect(selectAxis({ x: third, y: third, z: third })).toEqual({ kind: "not-axis-aligned" });
  });
});

describe("principalAxisOf", () => {
  it("resolves a unit axis vector to its principal axis", () => {
    expect(principalAxisOf({ x: 1, y: 0, z: 0 })).toBe("x");
    expect(principalAxisOf({ x: 0, y: -1, z: 0 })).toBe("y");
    expect(principalAxisOf({ x: 0, y: 0, z: 1 })).toBe("z");
  });

  it("returns null for a non-principal (diagonal) axis", () => {
    expect(principalAxisOf({ x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 })).toBeNull();
  });
});

describe("growRegion + recognizeRegion on a real welded/adjacent tube mesh", () => {
  for (const axis of ["x", "y", "z"] as Axis[]) {
    it(`recognizes a full-ring bore along the ${axis} axis from any seed triangle`, () => {
      const mesh = buildTubeMesh(axis, [0, 0], 10, 48, [0, 20], "hole");
      for (const seed of [0, 10, 40, mesh.triangles.length - 1]) {
        const outcome = recognizeRegion(mesh, seed);
        expect(outcome.status).toBe("recognized");
        if (outcome.status === "recognized") {
          expect(outcome.inspection.axis).toBe(axis);
          expect(outcome.inspection.surface).toBe("hole");
          expect(outcome.inspection.diameterMm).toBeCloseTo(20, 6);
          // Every triangle in this fixture belongs to the one ring; growth
          // from any seed reaches the whole mesh.
          expect(outcome.regionTriangles.length).toBe(mesh.triangles.length);
        }
      }
    });
  }

  it("grows an outward-facing wall as an 'outside' surface", () => {
    const mesh = buildTubeMesh("z", [5, -3], 15, 48, [0, 30], "outside");
    const outcome = recognizeRegion(mesh, 0);
    expect(outcome.status).toBe("recognized");
    if (outcome.status === "recognized") {
      expect(outcome.inspection.surface).toBe("outside");
      expect(outcome.inspection.diameterMm).toBeCloseTo(30, 6);
    }
  });

  it("refuses planar on a flat quad", () => {
    const mesh = buildFlatQuadMesh("z", 5, [0, 20], [0, 20]);
    const outcome = recognizeRegion(mesh, 0);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.refusal.code).toBe("planar");
    }
  });

  it("refuses too-coarse on a hex-boss ring (6 facets, below minSegments)", () => {
    const mesh = buildTubeMesh("z", [0, 0], 10, 6, [0, 10], "outside");
    const outcome = recognizeRegion(mesh, 0);
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.refusal.code).toBe("too-coarse");
    }
  });

  it("growRegion stays within a single axis-perpendicular ring and does not leak past an end cap", () => {
    const mesh = buildTubeMesh("z", [0, 0], 10, 48, [0, 20], "outside");
    const region = growRegion(mesh, 0, "z", 31);
    expect(region.length).toBe(mesh.triangles.length); // this fixture has no end caps -- the whole wall is one region
    expect(new Set(region).size).toBe(region.length); // no duplicate visits
  });
});
