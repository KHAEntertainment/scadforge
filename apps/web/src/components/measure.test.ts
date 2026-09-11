import { describe, expect, it } from "vitest";
import {
  bboxSize,
  edgeDimension,
  edgeDimensions,
  faceCenters,
  facePlanes,
  formatMm,
  isValidBBox,
  parallelEdges,
  selectCameraFacingEdge,
  type BBox
} from "./measure.js";

const CUBE_10: BBox = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
/** Off-origin, non-cubic box — models are authored at arbitrary scales and positions. */
const BRACKET: BBox = { min: { x: 5, y: -2, z: 1 }, max: { x: 105, y: 58, z: 13 } };

describe("isValidBBox", () => {
  it("accepts a finite, non-inverted box", () => {
    expect(isValidBBox(CUBE_10)).toBe(true);
  });

  it("counterexample: rejects null/undefined, NaN, Infinity, and inverted bounds (degenerate STL must not produce NaN geometry)", () => {
    expect(isValidBBox(null)).toBe(false);
    expect(isValidBBox(undefined)).toBe(false);
    expect(isValidBBox({ min: { x: 0, y: 0, z: 0 }, max: { x: NaN, y: 1, z: 1 } })).toBe(false);
    expect(isValidBBox({ min: { x: 0, y: 0, z: 0 }, max: { x: Infinity, y: 1, z: 1 } })).toBe(false);
    expect(isValidBBox({ min: { x: 5, y: 0, z: 0 }, max: { x: 4, y: 1, z: 1 } })).toBe(false);
  });
});

describe("bboxSize", () => {
  it("returns per-axis extents in mm", () => {
    expect(bboxSize(BRACKET)).toEqual({ x: 100, y: 60, z: 12 });
  });
});

describe("formatMm", () => {
  it("prints integers bare and fractions with one decimal", () => {
    expect(formatMm(105)).toBe("105");
    expect(formatMm(12.5)).toBe("12.5");
    expect(formatMm(12.04)).toBe("12");
    expect(formatMm(12.06)).toBe("12.1");
    expect(formatMm(0)).toBe("0");
  });
});

describe("parallelEdges", () => {
  it("enumerates exactly the four parallel bbox edges for each axis", () => {
    for (const axis of ["x", "y", "z"] as const) {
      const edges = parallelEdges(BRACKET, axis);
      expect(edges).toHaveLength(4);
      // Each edge spans the bbox on the measured axis (endpoints differ on
      // exactly that axis) and runs along the two free axes.
      for (const edge of edges) {
        const freeAxes = (["x", "y", "z"] as const).filter((a) => a !== axis);
        // The measured-axis coordinate is bbox min/max (not middle).
        expect([BRACKET.min[axis], BRACKET.max[axis]]).toContain(edge[0][axisIndex(axis)]);
        // On each free axis, the edge either spans the full bbox or sits at one of the two corners.
        for (const free of freeAxes) {
          const v0 = edge[0][axisIndex(free)];
          const v1 = edge[1][axisIndex(free)];
          expect([BRACKET.min[free], BRACKET.max[free]]).toContain(v0);
          expect([BRACKET.min[free], BRACKET.max[free]]).toContain(v1);
        }
      }
    }
  });
});

describe("selectCameraFacingEdge", () => {
  it("picks the edge whose midpoint projects most positively along the camera direction", () => {
    // Camera looking from +Y → the +Y (maxY) edge has the highest projected midpoint.
    const picked = selectCameraFacingEdge(BRACKET, "x", { x: 0, y: 1, z: 0 });
    expect(picked[0][1]).toBe(BRACKET.max.y);
    expect(picked[1][1]).toBe(BRACKET.max.y);
  });

  it("picks a different edge when the camera direction changes (the camera-aware refinement)", () => {
    const fromAbove = selectCameraFacingEdge(BRACKET, "x", { x: 0, y: 0, z: 1 });
    const fromBelow = selectCameraFacingEdge(BRACKET, "x", { x: 0, y: 0, z: -1 });
    expect(fromAbove[0][2]).toBe(BRACKET.max.z);
    expect(fromBelow[0][2]).toBe(BRACKET.min.z);
  });

  it("falls back to a deterministic default edge when the camera direction is null", () => {
    const picked = selectCameraFacingEdge(BRACKET, "x", null);
    expect(picked).toEqual([
      [BRACKET.min.x, BRACKET.min.y, BRACKET.min.z],
      [BRACKET.max.x, BRACKET.min.y, BRACKET.min.z]
    ]);
  });

  it("falls back when the camera direction has zero magnitude (degenerate input)", () => {
    const picked = selectCameraFacingEdge(BRACKET, "y", { x: 0, y: 0, z: 0 });
    // Default for Y: right-bottom edge (max X, min Z).
    expect(picked[0][0]).toBe(BRACKET.max.x);
    expect(picked[0][2]).toBe(BRACKET.min.z);
  });
});

describe("edgeDimension (hybrid display)", () => {
  it("anchors each measurement to a real bbox edge spanning exactly the axis extent", () => {
    const dims = edgeDimensions(BRACKET, null);
    expect(dims.map((d) => d.axis)).toEqual(["x", "y", "z"]);
    expect(dims.map((d) => d.sizeMm)).toEqual([100, 60, 12]);

    const [xDim] = dims;
    expect(xDim.edge[1][0] - xDim.edge[0][0]).toBe(100);
  });

  it("every edge endpoint lies on the bounding box (the highlight pins to model corners)", () => {
    for (const dim of edgeDimensions(BRACKET, null)) {
      for (const [x, y, z] of dim.endpoints) {
        expect([BRACKET.min.x, BRACKET.max.x]).toContain(x);
        expect([BRACKET.min.y, BRACKET.max.y]).toContain(y);
        expect([BRACKET.min.z, BRACKET.max.z]).toContain(z);
      }
    }
  });

  it("labels hug their edge: at its midpoint along the axis, nudged perpendicular to the edge outside the bbox", () => {
    const [xDim] = edgeDimensions(BRACKET, null);
    // Label sits at the X midpoint of the edge.
    expect(xDim.labelPosition[0]).toBeCloseTo((BRACKET.min.x + BRACKET.max.x) / 2);
    // The label is OUTSIDE the bbox perpendicular to the X axis — the
    // dimension line is the bbox edge itself, the label sits beside it,
    // never on top of the model.
    expect(xDim.labelPosition[1]).not.toBeCloseTo((xDim.edge[0][1] + xDim.edge[1][1]) / 2);
    // For the default X edge (front-bottom, min Y), the label is on the
    // -Y side, well outside the bbox.
    expect(xDim.labelPosition[1]).toBeLessThan(BRACKET.min.y);
  });

  it("camera direction picks the camera-facing edge and nudges the label toward the camera", () => {
    const fromFront = edgeDimension(BRACKET, "x", { x: 0, y: -1, z: 0 });
    const fromBack = edgeDimension(BRACKET, "x", { x: 0, y: 1, z: 0 });
    // From the front, the camera-facing edge is the minY one.
    expect(fromFront.edge[0][1]).toBe(BRACKET.min.y);
    // The label sits perpendicular to the edge, on the camera side —
    // outside the bbox on the Y axis.
    expect(fromFront.labelPosition[1]).toBeLessThan(BRACKET.min.y);
    // From the back, both the edge AND the label move to the +Y side.
    expect(fromBack.edge[0][1]).toBe(BRACKET.max.y);
    expect(fromBack.labelPosition[1]).toBeGreaterThan(BRACKET.max.y);
  });

  it("counterexample: a degenerate zero-size box still yields finite geometry", () => {
    const point: BBox = { min: { x: 1, y: 1, z: 1 }, max: { x: 1, y: 1, z: 1 } };
    for (const dim of edgeDimensions(point, null)) {
      expect(dim.edge.flat().every(Number.isFinite)).toBe(true);
      expect(dim.sizeMm).toBe(0);
    }
  });
});

describe("faceCenters", () => {
  it("returns the two face centers perpendicular to the axis, spanning the face-to-face distance", () => {
    const [a, b] = faceCenters(BRACKET, "y");
    expect(a[1]).toBe(BRACKET.min.y);
    expect(b[1]).toBe(BRACKET.max.y);
    expect(b[1] - a[1]).toBe(60);
    // Centred along the non-measured axes.
    expect(a[0]).toBeCloseTo((BRACKET.min.x + BRACKET.max.x) / 2);
    expect(a[2]).toBeCloseTo((BRACKET.min.z + BRACKET.max.z) / 2);
  });
});

describe("facePlanes", () => {
  it("returns the two bbox planes perpendicular to the chosen axis", () => {
    const planes = facePlanes(BRACKET, "y");
    expect(planes).toHaveLength(2);
    expect(planes[0].position[1]).toBe(BRACKET.min.y);
    expect(planes[1].position[1]).toBe(BRACKET.max.y);
    // The face-to-face distance they span is the axis extent.
    expect(planes[1].position[1] - planes[0].position[1]).toBe(60);
    // Each plane spans the other two axes' extents (X×Z for a Y plane).
    expect(planes[0].size).toEqual([100, 12]);
  });

  it("centres planes on the box along the non-measured axes", () => {
    const [plane] = facePlanes(BRACKET, "z");
    expect(plane.position[0]).toBeCloseTo((BRACKET.min.x + BRACKET.max.x) / 2);
    expect(plane.position[1]).toBeCloseTo((BRACKET.min.y + BRACKET.max.y) / 2);
  });
});

/** Tiny helper to map an axis name to its index in the BBoxPoint tuple. */
function axisIndex(axis: "x" | "y" | "z"): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}
