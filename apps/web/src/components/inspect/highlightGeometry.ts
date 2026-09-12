/**
 * Pure geometry for `SurfaceHighlight.tsx` — the axis line, diameter
 * line and label position for a recognized cylinder, plus the
 * triangle-index mapping that turns `regionTriangles` into an overlay
 * mesh's positions. Same split as `measure.ts` / `DimensionOverlay.tsx`:
 * the three.js rendering is a thin mapping over what lives here, kept
 * unit-testable without a WebGL context.
 */

import type { Axis, Vec3 } from "../measure.js";
import type { CylinderInspection } from "./inspectionTypes.js";

/**
 * The first of the two free (non-axis) coordinates, in the same cyclic
 * convention `cylinderFit.ts` uses internally (x → y, y → z, z → x) —
 * the diameter line's direction.
 */
function freeAxis(axis: Axis): Axis {
  switch (axis) {
    case "x":
      return "y";
    case "y":
      return "z";
    case "z":
      return "x";
  }
}

/** A point as an [x, y, z] tuple — the shape drei's `<Line>`/`<Html>` expect, matching `measure.ts`'s `Edge`/`labelPosition` convention. */
export type Point3 = [number, number, number];

export interface CylinderHighlightGeometry {
  /** Through the center, spanning the region's measured axial extent. */
  axisLine: [Point3, Point3];
  /** Through the center, perpendicular to the axis, spanning the full diameter. */
  diameterLine: [Point3, Point3];
  /** Where the "Ø {mm}" label sits — the outer end of the diameter line. */
  labelPosition: Point3;
}

function toTuple(v: Vec3): Point3 {
  return [v.x, v.y, v.z];
}

function withAxis(v: Vec3, axis: Axis, value: number): Point3 {
  return toTuple({ ...v, [axis]: value });
}

/** Builds the axis line, diameter line and label position for a recognized cylinder's highlight. */
export function cylinderHighlightGeometry(inspection: CylinderInspection): CylinderHighlightGeometry {
  const { axis, center, diameterMm, evidence } = inspection;
  const radius = diameterMm / 2;
  const halfAxialLength = evidence.axialLengthMm / 2;
  const u = freeAxis(axis);

  const axisLine: [Point3, Point3] = [withAxis(center, axis, center[axis] - halfAxialLength), withAxis(center, axis, center[axis] + halfAxialLength)];
  const diameterLine: [Point3, Point3] = [withAxis(center, u, center[u] - radius), withAxis(center, u, center[u] + radius)];
  const labelPosition: Point3 = diameterLine[1];

  return { axisLine, diameterLine, labelPosition };
}

/**
 * Extracts the positions of `regionTriangles` (indices into the
 * displayed, unindexed geometry's triangle list — 9 numbers per
 * triangle, 3 vertices × xyz) from its flat position array. Pure and
 * three.js-free so the triangle-index mapping is directly testable;
 * `SurfaceHighlight.tsx` wraps the result in a `BufferAttribute`.
 */
export function extractHighlightPositions(sourcePositions: ArrayLike<number>, regionTriangles: Uint32Array): Float32Array {
  const out = new Float32Array(regionTriangles.length * 9);
  for (let i = 0; i < regionTriangles.length; i++) {
    const srcOffset = regionTriangles[i] * 9;
    const dstOffset = i * 9;
    for (let k = 0; k < 9; k++) {
      out[dstOffset + k] = sourcePositions[srcOffset + k];
    }
  }
  return out;
}
