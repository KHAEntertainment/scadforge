// @scadforge/scad-core — three-free port of the region-growth and
// axis-selection logic in apps/web/src/components/inspect/surfaceRegion.ts
// (lines 167-311 there), built on `./mesh.js`'s `WeldedMesh` (Issue #91,
// S3-B ticket B5).
//
// `apps/web`'s `surfaceRegion.ts` keeps its three.js `BufferGeometry` entry
// (`buildWeldedMesh`/`getWeldedMesh`/`inspectSurface`) and now delegates this
// module's math instead of duplicating it. This package's proof service
// (`../editor/proof.ts`) builds a `WeldedMesh` from a rendered STL via
// `topology.ts` and calls `recognizeRegion`/`radialMatch.ts` directly — no
// three.js, no Node builtins here.
//
// SPDX-License-Identifier: Apache-2.0

import type { Axis, Vec3 } from "./vec.js";
import { angleBetweenDeg, type WeldedMesh } from "./mesh.js";
import { INSPECTION_THRESHOLDS } from "./thresholds.js";
import { angularStepsDeg, evaluateCylinder, fitCircleInPlane } from "./cylinderFit.js";
import { notAxisAlignedRefusal, planarRefusal, tooCoarseRefusal } from "./refusals.js";
import type { InspectionOutcome } from "./inspectionTypes.js";

const AXES: readonly Axis[] = ["x", "y", "z"];

function vecAxis(v: Vec3, axis: Axis): number {
  return v[axis];
}

export type AxisSelection = { kind: "planar" } | { kind: "axis"; axis: Axis } | { kind: "not-axis-aligned" };

/**
 * True when `axis` (assumed already normalized per the wire's finite-
 * normalized-Vec3 invariant, `EDITOR_RADIAL_AXIS_NORM_TOLERANCE`) is aligned
 * with exactly one principal axis (x, y or z) within
 * `maxAxialNormalComponent` — i.e. its other two components are both near
 * zero. Returns that axis, or `null` when the declared axis is not
 * principal — an unsupported radial-binding orientation per the S1
 * contract (used by `../editor/eligibility.ts` and
 * `../editor/proof.ts`/`radialMatch.ts`).
 */
export function principalAxisOf(axis: Vec3): Axis | null {
  const threshold = INSPECTION_THRESHOLDS.maxAxialNormalComponent;
  const smallAxes = AXES.filter((a) => Math.abs(vecAxis(axis, a)) <= threshold);
  if (smallAxes.length !== 2) return null;
  const dominant = AXES.find((a) => !smallAxes.includes(a));
  return dominant ?? null;
}

/**
 * A normal along a principal axis (its component on that axis dominates,
 * i.e. the other two components are both near zero) is a flat surface:
 * `planar`. A normal perpendicular to exactly one principal axis (that
 * axis's own component is near zero, the other two are not) selects
 * that axis as the candidate cylinder axis. Anything else — a cone, a
 * tilted cylinder, a sphere — is `not-axis-aligned`.
 */
export function selectAxis(normal: Vec3): AxisSelection {
  const threshold = INSPECTION_THRESHOLDS.maxAxialNormalComponent;
  const smallAxes = AXES.filter((axis) => Math.abs(vecAxis(normal, axis)) <= threshold);
  if (smallAxes.length === 2) return { kind: "planar" };
  if (smallAxes.length === 1) return { kind: "axis", axis: smallAxes[0] };
  return { kind: "not-axis-aligned" };
}

/**
 * Grow the region of edge-adjacent triangles starting at `seedTriangle`,
 * admitting a neighbor only if its normal stays perpendicular to `axis`
 * (within `maxAxialNormalComponent`) and its angle to the triangle it
 * was reached from is at most `maxStepDeg`. Growth naturally stops at
 * end caps (normal no longer perpendicular to the axis), sharp edges
 * (angle too large) and boolean seams (the far side's normal fails
 * either check) — no special-casing needed for any of them.
 *
 * `maxStepDeg` is a parameter, not always `maxFacetStepDeg`: the
 * coarse-polygon probe below re-runs this same growth with a wider
 * angle ceiling to test for a coarser regular polygon once the normal
 * (31°) region has already come back flat.
 */
export function growRegion(mesh: WeldedMesh, seedTriangle: number, axis: Axis, maxStepDeg: number): number[] {
  const threshold = INSPECTION_THRESHOLDS.maxAxialNormalComponent;
  const visited = new Set<number>([seedTriangle]);
  const queue: number[] = [seedTriangle];

  while (queue.length > 0) {
    const current = queue.shift() as number;
    const currentNormal = mesh.faceNormals[current];
    for (const neighbor of mesh.neighbors[current]) {
      if (visited.has(neighbor)) continue;
      const neighborNormal = mesh.faceNormals[neighbor];
      if (Math.abs(vecAxis(neighborNormal, axis)) > threshold) continue;
      if (angleBetweenDeg(currentNormal, neighborNormal) > maxStepDeg) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  return Array.from(visited);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Distinct facet normal directions in the region (pairwise-clustered, not exact-equality, since floats), used to tell "several distinct facets" apart from "one flat facet sampled repeatedly". */
export function distinctNormalCount(mesh: WeldedMesh, regionTriangles: readonly number[]): number {
  const CLUSTER_DEG = 0.5;
  const uniqueNormals: Vec3[] = [];
  for (const t of regionTriangles) {
    const normal = mesh.faceNormals[t];
    const isDuplicate = uniqueNormals.some((u) => angleBetweenDeg(u, normal) < CLUSTER_DEG);
    if (!isDuplicate) uniqueNormals.push(normal);
  }
  return uniqueNormals.length;
}

/** The largest pairwise angle (degrees) between any two triangles' normals in the region. */
export function normalSpreadDeg(mesh: WeldedMesh, regionTriangles: readonly number[]): number {
  let maxSpread = 0;
  for (let i = 0; i < regionTriangles.length; i++) {
    for (let j = i + 1; j < regionTriangles.length; j++) {
      const spread = angleBetweenDeg(mesh.faceNormals[regionTriangles[i]], mesh.faceNormals[regionTriangles[j]]);
      if (spread > maxSpread) maxSpread = spread;
    }
  }
  return maxSpread;
}

/** Unique welded vertices used by the region, plus the average of the region's own face normals at each vertex (not all faces touching it globally). */
export function regionVerticesAndNormals(mesh: WeldedMesh, regionTriangles: readonly number[]): { vertices: Vec3[]; normals: Vec3[] } {
  const sums = new Map<number, { normal: Vec3; count: number }>();
  for (const t of regionTriangles) {
    const normal = mesh.faceNormals[t];
    for (const vertexIndex of mesh.triangles[t]) {
      const entry = sums.get(vertexIndex);
      if (entry) {
        entry.normal.x += normal.x;
        entry.normal.y += normal.y;
        entry.normal.z += normal.z;
        entry.count += 1;
      } else {
        sums.set(vertexIndex, { normal: { x: normal.x, y: normal.y, z: normal.z }, count: 1 });
      }
    }
  }

  const vertices: Vec3[] = [];
  const normals: Vec3[] = [];
  for (const [vertexIndex, { normal, count }] of sums) {
    vertices.push(mesh.positions[vertexIndex]);
    normals.push(normalizeAvg(normal, count));
  }
  return { vertices, normals };
}

function normalizeAvg(sum: Vec3, count: number): Vec3 {
  const avg = { x: sum.x / count, y: sum.y / count, z: sum.z / count };
  const len = Math.hypot(avg.x, avg.y, avg.z);
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 };
  return { x: avg.x / len, y: avg.y / len, z: avg.z / len };
}

/**
 * Reached only when the normal (31°) region came back flat. A flat
 * region is ambiguous on its own: it could be a genuinely flat surface
 * (a chamfer strip), or it could be one facet — or a few — of a coarser
 * regular polygon whose next facet was rejected by `maxFacetStepDeg`
 * (a hex boss's 60° step, an octagon's 45°). Re-growing from the same
 * seed with a wider angle ceiling (`coarseProbeMaxStepDeg`) settles
 * which: if what comes back is a genuine regular polygon — several
 * distinct facets, its vertices fit a circle, and every angular step
 * around that circle is close to the median (an irregular shape like a
 * chamfered box corner alternates long and short steps) — refuse
 * `too-coarse` with the segment count from that fit. Otherwise the
 * region really is flat: refuse `planar`.
 */
export function coarsePolygonOrPlanar(mesh: WeldedMesh, seedTriangle: number, axis: Axis): InspectionOutcome {
  const probeTriangles = growRegion(mesh, seedTriangle, axis, INSPECTION_THRESHOLDS.coarseProbeMaxStepDeg);

  if (distinctNormalCount(mesh, probeTriangles) >= 3) {
    const { vertices: probeVertices } = regionVerticesAndNormals(mesh, probeTriangles);
    const fit = fitCircleInPlane(axis, probeVertices);
    const fitIsFinite = Number.isFinite(fit.radius) && Number.isFinite(fit.maxDeviationMm) && Number.isFinite(fit.center.x) && Number.isFinite(fit.center.y) && Number.isFinite(fit.center.z);

    if (fitIsFinite && fit.maxDeviationMm <= INSPECTION_THRESHOLDS.maxDeviationMm) {
      const steps = angularStepsDeg(axis, probeVertices, fit.center);
      const medianStepDeg = median(steps);
      const isRegular = steps.every((step) => Math.abs(step - medianStepDeg) <= INSPECTION_THRESHOLDS.coarseProbeStepToleranceDeg);

      if (isRegular && medianStepDeg > 0) {
        return { status: "refused", refusal: tooCoarseRefusal(Math.round(360 / medianStepDeg)) };
      }
    }
  }

  return { status: "refused", refusal: planarRefusal() };
}

/**
 * From a seed triangle on a `WeldedMesh`, to a recognized cylinder or a
 * refusal. Synchronous and pure. This is the shared core behind web's
 * click-driven `inspectSurface` (which builds `mesh` from a three.js
 * `BufferGeometry` and calls this with the clicked triangle) and this
 * package's declared-binding radial proof check (`radialMatch.ts`, which
 * builds `mesh` from a rendered STL and calls this per candidate seed).
 */
export function recognizeRegion(mesh: WeldedMesh, triangleIndex: number): InspectionOutcome {
  const seedNormal = mesh.faceNormals[triangleIndex];

  const selection = selectAxis(seedNormal);
  if (selection.kind === "planar") {
    return { status: "refused", refusal: planarRefusal() };
  }
  if (selection.kind === "not-axis-aligned") {
    return { status: "refused", refusal: notAxisAlignedRefusal() };
  }

  const axis = selection.axis;
  const regionTriangleIndices = growRegion(mesh, triangleIndex, axis, INSPECTION_THRESHOLDS.maxFacetStepDeg);

  if (normalSpreadDeg(mesh, regionTriangleIndices) < INSPECTION_THRESHOLDS.maxFacetStepDeg) {
    // Flat at the normal growth threshold -- ambiguous between a
    // genuine flat surface and a coarser polygon whose next facet this
    // threshold correctly excluded. The probe settles it.
    return coarsePolygonOrPlanar(mesh, triangleIndex, axis);
  }

  const { vertices, normals } = regionVerticesAndNormals(mesh, regionTriangleIndices);
  const outcome = evaluateCylinder(axis, vertices, normals);

  if ("code" in outcome) {
    return { status: "refused", refusal: outcome };
  }

  const regionTriangles = Uint32Array.from(regionTriangleIndices);
  return { status: "recognized", inspection: outcome, regionTriangles };
}
