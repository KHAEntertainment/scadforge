/**
 * Cylinder-fit math (S2 scope, recognition method steps 5–7). Pure
 * functions of a region's vertices and normals — no three.js import,
 * same style as `measure.ts`, so the whole thing is unit-testable
 * without a WebGL context. Planar detection and axis selection (steps
 * 3–4) and region growth (step 4) belong to ticket 2; this module
 * starts from an already-selected axis and an already-grown region.
 *
 * Fit method: OpenSCAD puts polygon vertices exactly on the modeled
 * circle, so fitting to the region's *vertices* (never facet midpoints,
 * which under-read by cos(π/$fn)) recovers the modeled radius exactly
 * for any `$fn`.
 */

import type { Axis, Vec3 } from "../measure.js";
import { INSPECTION_THRESHOLDS } from "./thresholds.js";
import { notCircularRefusal, partialArcRefusal, tooCoarseRefusal } from "./refusals.js";
import type { CylinderInspection, Refusal } from "./inspectionTypes.js";

const TAU = Math.PI * 2;

/**
 * Project a 3D point into the 2D plane perpendicular to `axis`, using a
 * fixed right-handed cyclic convention (x → (y, z), y → (z, x), z → (x,
 * y)) so the mapping back to 3D (`unproject2D`) is unambiguous.
 */
function project2D(p: Vec3, axis: Axis): [number, number] {
  switch (axis) {
    case "x":
      return [p.y, p.z];
    case "y":
      return [p.z, p.x];
    case "z":
      return [p.x, p.y];
  }
}

/** Inverse of `project2D`: places a fitted 2D point back on the plane at the given axial coordinate. */
function unproject2D(u: number, v: number, axialValue: number, axis: Axis): Vec3 {
  switch (axis) {
    case "x":
      return { x: axialValue, y: u, z: v };
    case "y":
      return { x: v, y: axialValue, z: u };
    case "z":
      return { x: u, y: v, z: axialValue };
  }
}

function axialCoord(p: Vec3, axis: Axis): number {
  return p[axis];
}

function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function determinant3(m: readonly (readonly number[])[]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function withColumn(m: readonly (readonly number[])[], col: 0 | 1 | 2, values: readonly number[]): number[][] {
  return m.map((row, i) => row.map((value, j) => (j === col ? values[i] : value)));
}

/** Cramer's-rule solve of a 3×3 linear system. */
function solve3x3(m: readonly (readonly number[])[], b: readonly number[]): [number, number, number] {
  const det = determinant3(m);
  return [
    determinant3(withColumn(m, 0, b)) / det,
    determinant3(withColumn(m, 1, b)) / det,
    determinant3(withColumn(m, 2, b)) / det
  ];
}

interface CircleFit2D {
  cx: number;
  cy: number;
  radius: number;
  maxDeviationMm: number;
}

/**
 * Algebraic (Kasa) circle fit: solves x² + y² + Dx + Ey + F = 0 via the
 * least-squares normal equations. For points that lie exactly on a
 * circle, the system is consistent and this recovers the circle exactly
 * (to float tolerance) — the property the "exact for points on a
 * circle" acceptance criterion depends on.
 */
function fitCircle2D(points: readonly [number, number][]): CircleFit2D {
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  const n = points.length;

  for (const [x, y] of points) {
    const z = -(x * x + y * y);
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }

  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n]
  ] as const;
  // Normal equations for least squares on Dx + Ey + F ≈ z, where
  // z = -(x²+y²): the right-hand side is M^T z = [sxz, syz, sz], already
  // carrying z's sign — do not re-negate here.
  const b = [sxz, syz, sz] as const;
  const [D, E, F] = solve3x3(A, b);

  const cx = -D / 2;
  const cy = -E / 2;
  const radius = Math.sqrt(Math.max(cx * cx + cy * cy - F, 0));

  let maxDeviationMm = 0;
  for (const [x, y] of points) {
    const deviation = Math.abs(Math.hypot(x - cx, y - cy) - radius);
    if (deviation > maxDeviationMm) maxDeviationMm = deviation;
  }

  return { cx, cy, radius, maxDeviationMm };
}

/**
 * Circle fit on the region's vertices, projected into the plane
 * perpendicular to `axis`. The 3D center sits on the axis, at the
 * region's axial midpoint.
 */
export function fitCircleInPlane(axis: Axis, vertices: readonly Vec3[]): { center: Vec3; radius: number; maxDeviationMm: number } {
  const points2D = vertices.map((v) => project2D(v, axis));
  const { cx, cy, radius, maxDeviationMm } = fitCircle2D(points2D);

  const axialValues = vertices.map((v) => axialCoord(v, axis));
  const axialMid = (Math.min(...axialValues) + Math.max(...axialValues)) / 2;

  return { center: unproject2D(cx, cy, axialMid, axis), radius, maxDeviationMm };
}

/**
 * Arc coverage (360° − largest angular gap between adjacent vertices,
 * measured around `center`) and the full-circle-equivalent segment
 * count (360° ÷ median angular step) — so a partial arc of a
 * 48-segment cylinder still reports 48. Near-duplicate angles (the same
 * angular position sampled at multiple axial rows) are deduplicated
 * before gaps are measured.
 */
export function angularCoverage(axis: Axis, vertices: readonly Vec3[], center: Vec3): { arcDegrees: number; segments: number } {
  const [ccx, ccy] = project2D(center, axis);

  const angles = vertices
    .map((v) => project2D(v, axis))
    .map(([x, y]) => Math.atan2(y - ccy, x - ccx))
    .sort((a, b) => a - b);

  const ANGLE_EPS = 1e-6;
  const uniqueAngles: number[] = [];
  for (const angle of angles) {
    if (uniqueAngles.length === 0 || angle - uniqueAngles[uniqueAngles.length - 1] > ANGLE_EPS) {
      uniqueAngles.push(angle);
    }
  }

  if (uniqueAngles.length < 2) {
    return { arcDegrees: 0, segments: uniqueAngles.length };
  }

  const stepsDeg: number[] = [];
  for (let i = 0; i < uniqueAngles.length; i++) {
    const next = uniqueAngles[(i + 1) % uniqueAngles.length];
    const rawGap = i === uniqueAngles.length - 1 ? next + TAU - uniqueAngles[i] : next - uniqueAngles[i];
    stepsDeg.push(radToDeg(rawGap));
  }

  const largestGapDeg = Math.max(...stepsDeg);
  const medianStepDeg = median(stepsDeg);
  const arcDegrees = 360 - largestGapDeg;
  const segments = medianStepDeg > 0 ? Math.round(360 / medianStepDeg) : uniqueAngles.length;

  return { arcDegrees, segments };
}

/**
 * Hole/outside classification: normals point toward the fitted center
 * → `hole`; away → `outside`. Uses the sign of the summed radial dot
 * product over the region, so isolated noisy normals don't flip the
 * call.
 */
export function classifySurface(axis: Axis, vertices: readonly Vec3[], normals: readonly Vec3[], center: Vec3): "hole" | "outside" {
  const [ccx, ccy] = project2D(center, axis);

  let radialDotSum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const [px, py] = project2D(vertices[i], axis);
    const [nx, ny] = project2D(normals[i], axis);
    const outwardX = px - ccx;
    const outwardY = py - ccy;
    radialDotSum += nx * outwardX + ny * outwardY;
  }

  return radialDotSum < 0 ? "hole" : "outside";
}

/**
 * Takes an axis and a region's vertices and normals, and returns a
 * `CylinderInspection` or a `Refusal` using the thresholds in
 * `thresholds.ts`. Check order is segments → arc → deviation, so the
 * reported reason is the most basic failure.
 */
export function evaluateCylinder(axis: Axis, vertices: readonly Vec3[], normals: readonly Vec3[]): CylinderInspection | Refusal {
  const fit = fitCircleInPlane(axis, vertices);
  const { arcDegrees, segments } = angularCoverage(axis, vertices, fit.center);

  if (segments < INSPECTION_THRESHOLDS.minSegments) {
    return tooCoarseRefusal(segments);
  }
  if (arcDegrees < INSPECTION_THRESHOLDS.minArcDegrees) {
    return partialArcRefusal(arcDegrees);
  }
  if (fit.maxDeviationMm > INSPECTION_THRESHOLDS.maxDeviationMm) {
    return notCircularRefusal(fit.maxDeviationMm);
  }

  const surface = classifySurface(axis, vertices, normals, fit.center);
  const axialValues = vertices.map((v) => axialCoord(v, axis));
  const axialLengthMm = Math.max(...axialValues) - Math.min(...axialValues);

  return {
    kind: "radial",
    surface,
    axis,
    center: fit.center,
    diameterMm: fit.radius * 2,
    evidence: {
      segments,
      arcDegrees,
      maxDeviationMm: fit.maxDeviationMm,
      axialLengthMm
    }
  };
}
