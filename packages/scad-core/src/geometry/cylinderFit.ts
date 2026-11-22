// @scadforge/scad-core — S2 cylinder-fit math, ported verbatim from
// apps/web/src/components/inspect/cylinderFit.ts (Issue #91, S3-B ticket
// B5).
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cylinder-fit math (S2 scope, recognition method steps 5–7). Pure
 * functions of a region's vertices and normals — no three.js import,
 * so the whole thing is unit-testable without a WebGL context, and safe to
 * run server-side against a rendered STL. Planar detection and axis
 * selection (steps 3–4) and region growth (step 4) live in
 * `regionGrowth.ts`; this module starts from an already-selected axis and
 * an already-grown region.
 *
 * Fit method: OpenSCAD puts polygon vertices exactly on the modeled
 * circle, so fitting to the region's *vertices* (never facet midpoints,
 * which under-read by cos(π/$fn)) recovers the modeled radius exactly
 * for any `$fn`.
 */

import type { Axis, Vec3 } from "./vec.js";
import { INSPECTION_THRESHOLDS } from "./thresholds.js";
import { notCircularRefusal, partialArcRefusal, planarRefusal, tooCoarseRefusal } from "./refusals.js";
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
 *
 * The normal equations are built on points centered at their centroid
 * (added back afterward): building them on raw coordinates is
 * ill-conditioned for a small feature far from the origin (e.g. a
 * Ø 4.5 hole at (150, 150)), where x²+y² dwarfs the terms that carry
 * the actual circle shape.
 *
 * A singular system (collinear points — a flat region) or any
 * non-finite fitted value yields `cx`/`cy`/`radius`/`maxDeviationMm`
 * all `NaN`; `evaluateCylinder` treats that as a degenerate, flat
 * region and refuses `planar`.
 */
function fitCircle2D(points: readonly [number, number][]): CircleFit2D {
  const n = points.length;
  const NON_FINITE_FIT: CircleFit2D = { cx: NaN, cy: NaN, radius: NaN, maxDeviationMm: NaN };
  if (n === 0) return NON_FINITE_FIT;

  let meanX = 0;
  let meanY = 0;
  for (const [x, y] of points) {
    meanX += x;
    meanY += y;
  }
  meanX /= n;
  meanY /= n;

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;

  for (const [px, py] of points) {
    const x = px - meanX;
    const y = py - meanY;
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

  const det = determinant3(A);
  if (!Number.isFinite(det) || det === 0) return NON_FINITE_FIT;

  const [D, E, F] = solve3x3(A, b);

  // Center relative to the centroid, then shifted back to the original frame.
  const cxLocal = -D / 2;
  const cyLocal = -E / 2;
  const radius = Math.sqrt(Math.max(cxLocal * cxLocal + cyLocal * cyLocal - F, 0));
  const cx = cxLocal + meanX;
  const cy = cyLocal + meanY;

  let maxDeviationMm = 0;
  for (const [x, y] of points) {
    const deviation = Math.abs(Math.hypot(x - cx, y - cy) - radius);
    if (deviation > maxDeviationMm) maxDeviationMm = deviation;
  }

  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || !Number.isFinite(maxDeviationMm)) {
    return NON_FINITE_FIT;
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
 * Sorted angular steps (degrees) between consecutive vertices, deduped
 * and measured circularly around `center` in the plane perpendicular to
 * `axis` — the raw building block `angularCoverage` derives arc
 * coverage and segment count from, exposed for other callers that need
 * the per-step values directly (the surface-region coarse-polygon
 * probe checks every step against the median, not just the largest).
 * Near-duplicate angles (the same angular position sampled at multiple
 * axial rows) are deduplicated first.
 */
export function angularStepsDeg(axis: Axis, vertices: readonly Vec3[], center: Vec3): number[] {
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

  if (uniqueAngles.length < 2) return [];

  const stepsDeg: number[] = [];
  for (let i = 0; i < uniqueAngles.length; i++) {
    const next = uniqueAngles[(i + 1) % uniqueAngles.length];
    const rawGap = i === uniqueAngles.length - 1 ? next + TAU - uniqueAngles[i] : next - uniqueAngles[i];
    stepsDeg.push(radToDeg(rawGap));
  }
  return stepsDeg;
}

/**
 * Arc coverage and the full-circle-equivalent segment count (360° ÷
 * median angular step) — so a partial arc of a 48-segment cylinder
 * still reports 48.
 *
 * Arc coverage: from vertices alone, a covered facet step can't be
 * told apart from a genuinely missing one, so a fully closed ring
 * (whose "largest gap" between adjacent vertices is otherwise just its
 * own uniform facet step) is detected by comparing the largest gap
 * against the median step. Largest gap ≤ 1.5 × median → closed ring,
 * `arcDegrees = 360`. Otherwise the largest gap is a genuine missing
 * arc: `arcDegrees = 360 − largest gap`.
 */
export function angularCoverage(axis: Axis, vertices: readonly Vec3[], center: Vec3): { arcDegrees: number; segments: number } {
  const stepsDeg = angularStepsDeg(axis, vertices, center);
  if (stepsDeg.length === 0) {
    // Fewer than 2 distinct angular positions -- not enough data for a
    // step. Unreachable via evaluateCylinder (a fit this degenerate is
    // already caught as a singular fit), kept defensive for direct callers.
    return { arcDegrees: 0, segments: 0 };
  }

  const largestGapDeg = Math.max(...stepsDeg);
  const medianStepDeg = median(stepsDeg);
  const isClosedRing = largestGapDeg <= 1.5 * medianStepDeg;
  const arcDegrees = isClosedRing ? 360 : 360 - largestGapDeg;
  const segments = medianStepDeg > 0 ? Math.round(360 / medianStepDeg) : stepsDeg.length;

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
 * Sagitta (mm): how far a regular polygon's straight facet CHORD dips
 * inside its true circumscribed circle, for `segments` sides of
 * circumradius `radius`. A boolean seam vertex (where another body meets
 * the wall) lands somewhere on that chord, not on the circle itself — up
 * to this far inside (S2-1 fixup 2).
 */
export function sagittaMm(radius: number, segments: number): number {
  if (!Number.isFinite(radius) || !Number.isFinite(segments) || segments <= 0) return 0;
  return radius * (1 - Math.cos(Math.PI / segments));
}

function isFiniteFit2D(fit: CircleFit2D): boolean {
  return Number.isFinite(fit.cx) && Number.isFinite(fit.cy) && Number.isFinite(fit.radius);
}

/** Sorted, deduplicated angles (radians) — same epsilon/convention as `angularStepsDeg`'s dedup, factored out so the robust fit below can reuse it on raw 2D angles before any Vec3/axis plumbing exists for the kept subset. */
function uniqueSortedAngles(angles: readonly number[]): number[] {
  const sorted = [...angles].sort((a, b) => a - b);
  const ANGLE_EPS = 1e-6;
  const unique: number[] = [];
  for (const angle of sorted) {
    if (unique.length === 0 || angle - unique[unique.length - 1] > ANGLE_EPS) {
      unique.push(angle);
    }
  }
  return unique;
}

/** Full-circle-equivalent segment count from a raw set of angles (radians) — the same "360° ÷ median step" formula as `angularCoverage`, usable before the kept subset has been turned back into Vec3s. */
function segmentsFromAngles(angles: readonly number[]): number {
  const unique = uniqueSortedAngles(angles);
  if (unique.length < 2) return unique.length;
  const steps: number[] = [];
  for (let i = 0; i < unique.length; i++) {
    const next = unique[(i + 1) % unique.length];
    const rawGap = i === unique.length - 1 ? next + TAU - unique[i] : next - unique[i];
    steps.push(radToDeg(rawGap));
  }
  const medianStepDeg = median(steps);
  return medianStepDeg > 0 ? Math.round(360 / medianStepDeg) : steps.length;
}

const MAX_ROBUST_FIT_ITERATIONS = 10;

interface RobustFit {
  center: Vec3;
  radius: number;
  /** Over the kept vertices only. */
  maxDeviationMm: number;
  /** Indices into the `vertices` array passed to `fitCircleRobust`. */
  keptIndices: number[];
}

type RobustFitOutcome =
  | { status: "fit"; fit: RobustFit }
  /** Singular fit (collinear points) — evaluateCylinder treats this as a flat region. */
  | { status: "degenerate" }
  | { status: "not-circular"; deviationMm: number };

/**
 * Robust circle fit (S2-1 fixup 2, `tickets/s2-1-cylinder-fit/fixup-2`).
 *
 * The original assumption — every region vertex lies on the modeled
 * circle — holds for the polygon's own vertices, but not for **seam
 * vertices** a boolean operation adds where another body meets the wall
 * (the clamp's ring meets its backplate at every wall value; at wall 2 a
 * screw hole breaks into the bore). Those sit on the facet CHORD between
 * two real vertices, up to `sagittaMm(radius, segments)` inside the true
 * circle.
 *
 * Fits on everything, then repeatedly drops whichever kept point lies
 * *inside* the fit by more than `maxDeviationMm` and refits, until
 * stable (capped). The survivors are the polygon's own vertices — used
 * for segments, arc, center, diameter and hole/outside — and every
 * dropped point must lie on a polygon chord within the sagitta band of
 * that final, stable fit. The survivors must also span the full axial
 * extent; inward axial rings cannot be erased as seam noise.
 * A point outside by more than `maxDeviationMm`
 * is never a chord point, so it fails immediately, on the spot. Ellipses
 * and tangent flats (slots) still fail: their residuals land outside the
 * circle somewhere, or a dropped point lands well past the sagitta band.
 */
function fitCircleRobust(axis: Axis, vertices: readonly Vec3[]): RobustFitOutcome {
  const maxDeviationMm = INSPECTION_THRESHOLDS.maxDeviationMm;
  const points2D = vertices.map((v) => project2D(v, axis));

  let keptIndices = vertices.map((_, i) => i);
  const droppedIndices: number[] = [];
  let fit = fitCircle2D(keptIndices.map((i) => points2D[i]));

  // Converge the drop/refit cycle to a stable set FIRST (rules 1–2), and
  // only THEN check the stable set for a genuine outside violation (rule
  // 5). A seam that traces a whole intersection curve (not just one chord
  // point — e.g. a screw hole boring straight through a ring wall) pulls
  // the very first, unrefined fit toward its own noise; on that skewed
  // fit, plenty of perfectly good polygon vertices can transiently read
  // as "outside" even though nothing is actually wrong with them. Only a
  // point that is STILL outside the fit once the inward-lying noise has
  // been removed is a genuine defect (an ellipse still fails here: with
  // its short-axis points removed as "inside", the long-axis points
  // remain clearly outside the tightened fit).
  for (let iter = 0; iter < MAX_ROBUST_FIT_ITERATIONS; iter++) {
    if (!isFiniteFit2D(fit)) return { status: "degenerate" };

    const stillKept: number[] = [];
    const newlyDropped: number[] = [];
    for (const i of keptIndices) {
      const [x, y] = points2D[i];
      const inwardMm = fit.radius - Math.hypot(x - fit.cx, y - fit.cy);
      if (inwardMm > maxDeviationMm) newlyDropped.push(i);
      else stillKept.push(i);
    }

    if (newlyDropped.length === 0) break; // stable: fit already matches keptIndices exactly

    // Rule 6, checked before refitting on the reduced set so a
    // near-degenerate remainder reports `not-circular`, never `planar`
    // (a genuinely singular fitCircle2D call would say "degenerate").
    const remainingAngles = stillKept.map((i) => Math.atan2(points2D[i][1] - fit.cy, points2D[i][0] - fit.cx));
    if (uniqueSortedAngles(remainingAngles).length < 3) {
      return { status: "not-circular", deviationMm: fit.maxDeviationMm };
    }

    droppedIndices.push(...newlyDropped);
    keptIndices = stillKept;
    fit = fitCircle2D(keptIndices.map((i) => points2D[i]));
  }

  if (!isFiniteFit2D(fit)) return { status: "degenerate" };

  // Rule 5: a point OUTSIDE the now-stable fit by more than the limit is
  // never a chord point (chords only ever sit inside), so it disqualifies
  // the region — an ellipse, or any shape that isn't a circle plus inward
  // seam noise, fails here even after every legitimately-inward point has
  // already been dropped above.
  let worstOutsideMm = 0;
  for (const i of keptIndices) {
    const [x, y] = points2D[i];
    const inwardMm = fit.radius - Math.hypot(x - fit.cx, y - fit.cy);
    if (inwardMm < -maxDeviationMm) worstOutsideMm = Math.max(worstOutsideMm, -inwardMm);
  }
  if (worstOutsideMm > 0) {
    return { status: "not-circular", deviationMm: worstOutsideMm };
  }

  // Rule 4: every dropped point must be consistent with a chord point of
  // the FINAL kept-vertex circle — inside by no more than
  // sagittaMm(radius, segments) + maxDeviationMm, on a polygon chord, and never outside it
  // (a chord point is never further out than the circle itself).
  const keptAngles = keptIndices.map((i) => Math.atan2(points2D[i][1] - fit.cy, points2D[i][0] - fit.cx));
  const segments = segmentsFromAngles(keptAngles);
  const sagittaBoundMm = sagittaMm(fit.radius, segments) + maxDeviationMm;

  const polygonAngles = uniqueSortedAngles(keptAngles);
  for (const i of droppedIndices) {
    const [x, y] = points2D[i];
    const inwardMm = fit.radius - Math.hypot(x - fit.cx, y - fit.cy);
    if (inwardMm < 0 || inwardMm > sagittaBoundMm) {
      return { status: "not-circular", deviationMm: Math.abs(inwardMm) };
    }

    // A radial band alone also admits a smaller end ring of a frustum.
    // A boolean seam must lie on the actual chord between adjacent
    // retained polygon corners, not merely somewhere inside the circle.
    const angle = Math.atan2(y - fit.cy, x - fit.cx);
    let lo = 0;
    let hi = polygonAngles.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (polygonAngles[mid] < angle) lo = mid + 1;
      else hi = mid;
    }
    let a = polygonAngles[(lo + polygonAngles.length - 1) % polygonAngles.length];
    let b = polygonAngles[lo % polygonAngles.length];
    const gap = (b - a + TAU) % TAU;
    const step = TAU / segments;
    if (gap > 1.5 * step) {
      // A boolean cut can truncate the terminal facet of a partial arc,
      // leaving its other polygon corner outside the grown region. Extend
      // only that one terminal facet, never the chord across the missing arc.
      const fromA = (angle - a + TAU) % TAU;
      const toB = (b - angle + TAU) % TAU;
      if (Math.min(fromA, toB) > step) {
        return { status: "not-circular", deviationMm: Math.abs(inwardMm) };
      }
      if (fromA < toB) b = a + step;
      else a = b - step;
    }
    const ax = fit.cx + fit.radius * Math.cos(a);
    const ay = fit.cy + fit.radius * Math.sin(a);
    const dx = fit.radius * Math.cos(b) + fit.cx - ax;
    const dy = fit.radius * Math.sin(b) + fit.cy - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    const chordDeviation = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (!Number.isFinite(chordDeviation) || chordDeviation > maxDeviationMm) {
      return { status: "not-circular", deviationMm: Math.max(Math.abs(inwardMm), chordDeviation) };
    }
  }

  let maxDeviationOfKeptMm = 0;
  for (const i of keptIndices) {
    const [x, y] = points2D[i];
    const deviation = Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.radius);
    if (deviation > maxDeviationOfKeptMm) maxDeviationOfKeptMm = deviation;
  }

  const axialValues = vertices.map((v) => axialCoord(v, axis));
  const keptAxialValues = keptIndices.map((i) => axialCoord(vertices[i], axis));
  const axialMin = Math.min(...axialValues);
  const axialMax = Math.max(...axialValues);
  const lostSpan = Math.max(Math.min(...keptAxialValues) - axialMin, axialMax - Math.max(...keptAxialValues));
  if (lostSpan > maxDeviationMm) {
    return { status: "not-circular", deviationMm: Math.max(...droppedIndices.map((i) => Math.abs(fit.radius - Math.hypot(points2D[i][0] - fit.cx, points2D[i][1] - fit.cy)))) };
  }
  const axialMid = (axialMin + axialMax) / 2;

  return {
    status: "fit",
    fit: {
      center: unproject2D(fit.cx, fit.cy, axialMid, axis),
      radius: fit.radius,
      maxDeviationMm: maxDeviationOfKeptMm,
      keptIndices
    }
  };
}

/**
 * Takes an axis and a region's vertices and normals, and returns a
 * `CylinderInspection` or a `Refusal` using the thresholds in
 * `thresholds.ts`. Check order is segments → arc → deviation, so the
 * reported reason is the most basic failure — computed from the ROBUST
 * fit's kept vertices (S2-1 fixup 2), which excludes boolean-seam noise
 * that the plain `fitCircleInPlane` fit would otherwise count against
 * `maxDeviationMm`.
 */
export function evaluateCylinder(axis: Axis, vertices: readonly Vec3[], normals: readonly Vec3[]): CylinderInspection | Refusal {
  const robust = fitCircleRobust(axis, vertices);
  if (robust.status === "degenerate") {
    // A singular fit (collinear points in the plane) means a flat region.
    return planarRefusal();
  }
  if (robust.status === "not-circular") {
    return notCircularRefusal(robust.deviationMm);
  }

  const { fit } = robust;
  const keptVertices = fit.keptIndices.map((i) => vertices[i]);
  const keptNormals = fit.keptIndices.map((i) => normals[i]);

  const { arcDegrees, segments } = angularCoverage(axis, keptVertices, fit.center);

  if (segments < INSPECTION_THRESHOLDS.minSegments) {
    return tooCoarseRefusal(segments);
  }
  if (arcDegrees < INSPECTION_THRESHOLDS.minArcDegrees) {
    return partialArcRefusal(arcDegrees);
  }
  // By construction every kept vertex is already within maxDeviationMm
  // both ways; kept for defense-in-depth and to keep the documented check
  // order (segments → arc → deviation) literally true in code.
  if (fit.maxDeviationMm > INSPECTION_THRESHOLDS.maxDeviationMm) {
    return notCircularRefusal(fit.maxDeviationMm);
  }

  const surface = classifySurface(axis, keptVertices, keptNormals, fit.center);
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
