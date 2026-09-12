import { describe, expect, it } from "vitest";
import { cylinderHighlightGeometry, extractHighlightPositions } from "./highlightGeometry.js";
import type { CylinderInspection } from "./inspectionTypes.js";

function inspection(overrides: Partial<CylinderInspection> = {}): CylinderInspection {
  return {
    kind: "radial",
    surface: "outside",
    axis: "z",
    center: { x: 5, y: -3, z: 10 },
    diameterMm: 40,
    evidence: { segments: 48, arcDegrees: 360, maxDeviationMm: 0, axialLengthMm: 20 },
    ...overrides
  };
}

describe("cylinderHighlightGeometry", () => {
  it("spans the axis line along the axis, centered on the inspection center, over the measured axial extent", () => {
    const { axisLine } = cylinderHighlightGeometry(inspection({ axis: "z", center: { x: 5, y: -3, z: 10 }, evidence: { segments: 48, arcDegrees: 360, maxDeviationMm: 0, axialLengthMm: 20 } }));
    expect(axisLine[0]).toEqual([5, -3, 0]);
    expect(axisLine[1]).toEqual([5, -3, 20]);
  });

  it("spans the diameter line perpendicular to the axis, through the center, over the full diameter", () => {
    const { diameterLine } = cylinderHighlightGeometry(inspection({ axis: "z", center: { x: 5, y: -3, z: 10 }, diameterMm: 40 }));
    // For axis z, the diameter line runs along x (the cyclic "free" axis).
    expect(diameterLine[0]).toEqual([-15, -3, 10]);
    expect(diameterLine[1]).toEqual([25, -3, 10]);
  });

  it("picks the diameter direction per axis: x -> y, y -> z, z -> x", () => {
    const forX = cylinderHighlightGeometry(inspection({ axis: "x", center: { x: 0, y: 0, z: 0 }, diameterMm: 10 }));
    expect(forX.diameterLine[0][1]).toBe(-5);
    expect(forX.diameterLine[1][1]).toBe(5);

    const forY = cylinderHighlightGeometry(inspection({ axis: "y", center: { x: 0, y: 0, z: 0 }, diameterMm: 10 }));
    expect(forY.diameterLine[0][2]).toBe(-5);
    expect(forY.diameterLine[1][2]).toBe(5);
  });

  it("labels the outer end of the diameter line", () => {
    const { diameterLine, labelPosition } = cylinderHighlightGeometry(inspection({ axis: "z", center: { x: 0, y: 0, z: 0 }, diameterMm: 40 }));
    expect(labelPosition).toEqual(diameterLine[1]);
  });
});

describe("extractHighlightPositions", () => {
  it("maps region triangle indices onto the correct 9-number blocks of the source (unindexed) position array", () => {
    // 3 triangles' worth of positions, values chosen so each triangle's
    // block is identifiable by its leading number.
    const source = new Float32Array([
      /* triangle 0 */ 0, 0, 0, 0, 1, 0, 0, 0, 1,
      /* triangle 1 */ 10, 0, 0, 10, 1, 0, 10, 0, 1,
      /* triangle 2 */ 20, 0, 0, 20, 1, 0, 20, 0, 1
    ]);

    const extracted = extractHighlightPositions(source, Uint32Array.from([2, 0]));

    expect(Array.from(extracted)).toEqual([20, 0, 0, 20, 1, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("counterexample: an empty region produces an empty (not undefined-filled) array", () => {
    const source = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const extracted = extractHighlightPositions(source, new Uint32Array(0));
    expect(extracted.length).toBe(0);
  });
});
