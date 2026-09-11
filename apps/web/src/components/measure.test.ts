import { describe, expect, it } from "vitest";
import { bboxSize, dimensionLines, facePlanes, formatMm, isValidBBox, type BBox } from "./measure.js";

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

describe("dimensionLines", () => {
  it("produces one dimension line per axis whose main segment spans exactly the bbox extent", () => {
    const lines = dimensionLines(BRACKET);
    expect(lines.map((l) => l.axis)).toEqual(["x", "y", "z"]);
    expect(lines.map((l) => l.sizeMm)).toEqual([100, 60, 12]);

    const xLine = lines[0];
    // Main segment: first pair of xyz endpoints.
    const [x1, y1, z1, x2, y2, z2] = xLine.segments;
    expect([x1, x2]).toEqual([BRACKET.min.x, BRACKET.max.x]);
    // Offset outward along exactly one axis (-Y), so the line sits outside the model.
    expect(y1).toBeLessThan(BRACKET.min.y);
    expect(y2).toBe(y1);
    expect(z1).toBe(BRACKET.min.z);
  });

  it("extension lines are axis-aligned and connect the dimension line to the model edges", () => {
    const [xLine] = dimensionLines(BRACKET);
    // segments layout: main (6 numbers), ext1 (6), ext2 (6)
    const ext1 = xLine.segments.slice(6, 12);
    // Extension from the dimension line end straight back to the model edge: only Y changes.
    expect(ext1[0]).toBe(ext1[3]); // x constant
    expect(ext1[2]).toBe(ext1[5]); // z constant
    expect(ext1[4]).toBe(BRACKET.min.y); // reaches the model
  });

  it("label position sits at the main line midpoint, nudged outward", () => {
    const [xLine] = dimensionLines(BRACKET);
    expect(xLine.labelPosition[0]).toBeCloseTo((BRACKET.min.x + BRACKET.max.x) / 2);
    expect(xLine.labelPosition[1]).toBeLessThan(BRACKET.min.y);
  });

  it("counterexample: a degenerate zero-size box still yields finite, non-zero-gap geometry", () => {
    const point: BBox = { min: { x: 1, y: 1, z: 1 }, max: { x: 1, y: 1, z: 1 } };
    for (const line of dimensionLines(point)) {
      expect(line.segments.every(Number.isFinite)).toBe(true);
      expect(line.sizeMm).toBe(0);
    }
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
