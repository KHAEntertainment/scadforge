// @scadforge/scad-core — declared-binding radial match scan (Issue #91,
// S3-B ticket B5, correction C3).
//
// The B5 proof service has no user click to seed recognition from (unlike
// web's `inspectSurface`) — it must find the region(s) matching a DECLARED
// binding's center/axis in a freshly rendered mesh. Rather than segmenting
// the entire mesh (recognizing every region, then filtering), this seeds
// only from faces consistent with the declared binding: normal
// perpendicular to the declared axis (within the S2 `maxAxialNormalComponent`
// threshold, the same test `selectAxis`/`growRegion` use) and centroid
// distance to the declared axis line no larger than a generous
// mesh-bounding-box-derived bound (prunes faces on the far side of a large
// part; the real radius/center match is still checked after growing).
//
// Every face grown into a region is marked assigned and never reseeded, so
// total faces visited across the whole scan is bounded by the mesh's own
// face count (each face contributes to at most one growth), not by
// faces × candidate-seeds. The one exception, noted where it happens, is
// `coarsePolygonOrPlanar`'s own wider re-probe on a locally flat region —
// it can revisit a few already-assigned-adjacent faces from a different
// seed, but that path can only ever return a refusal (never "recognized",
// see its source), so it can never inflate the match count; it costs a
// bounded, small amount of redundant work, not a correctness risk.
//
// SPDX-License-Identifier: Apache-2.0

import type { Axis, Vec3 } from "./vec.js";
import type { WeldedMesh } from "./mesh.js";
import { INSPECTION_THRESHOLDS } from "./thresholds.js";
import { evaluateCylinder } from "./cylinderFit.js";
import { coarsePolygonOrPlanar, growRegion, normalSpreadDeg, regionVerticesAndNormals } from "./regionGrowth.js";
import type { CylinderInspection, InspectionOutcome } from "./inspectionTypes.js";

function vecAxis(v: Vec3, axis: Axis): number {
  return v[axis];
}

/** Perpendicular distance from `p` to the axis line through `center` running along the principal `axis`. */
function distanceToAxisLine(p: Vec3, center: Vec3, axis: Axis): number {
  switch (axis) {
    case "x":
      return Math.hypot(p.y - center.y, p.z - center.z);
    case "y":
      return Math.hypot(p.z - center.z, p.x - center.x);
    case "z":
      return Math.hypot(p.x - center.x, p.y - center.y);
  }
}

function triangleCentroid(mesh: WeldedMesh, t: number): Vec3 {
  const [a, b, c] = mesh.triangles[t];
  const pa = mesh.positions[a];
  const pb = mesh.positions[b];
  const pc = mesh.positions[c];
  return { x: (pa.x + pb.x + pc.x) / 3, y: (pa.y + pb.y + pc.y) / 3, z: (pa.z + pb.z + pc.z) / 3 };
}

/** Half the mesh's own bounding-box diagonal — a generous upper bound no real feature's radius could plausibly exceed, used only to prune obviously-unrelated faces before growing a region. */
function boundingRadius(mesh: WeldedMesh): number {
  if (mesh.positions.length === 0) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const p of mesh.positions) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
}

/** The two off-axis coordinates of `v` for `axis` — the radial position. */
function radialCoords(v: Vec3, axis: Axis): [number, number] {
  switch (axis) {
    case "x":
      return [v.y, v.z];
    case "y":
      return [v.z, v.x];
    case "z":
      return [v.x, v.y];
  }
}

/**
 * Real parts commonly place several coaxial features at the SAME radial
 * position and axis but different axial ranges (e.g. the S3-B B5 hinge
 * fixture's three knuckle bores: same bore diameter/axis/radial center,
 * separated along X) — radial position and axis alone are not enough to
 * pick out the one the declared binding actually refers to. A recognized
 * region matches the declared binding when its RADIAL position agrees (the
 * two coordinates perpendicular to `axis`) within the S2 circle-fit
 * deviation tolerance, AND the declared center's axial coordinate falls
 * within the region's own actual axial span — `evaluateCylinder`'s
 * `center`'s axial component is the region's axial MIDPOINT and
 * `evidence.axialLengthMm` its extent, so the span is
 * `[center ± axialLengthMm/2]` (widened by a small edge tolerance: a
 * legitimately-declared reference point can sit anywhere along a through-
 * hole's length, not necessarily exactly at its midpoint).
 */
function matchesDeclaredBinding(match: CylinderInspection, declaredCenter: Vec3, axis: Axis): boolean {
  const radialTolerance = INSPECTION_THRESHOLDS.maxDeviationMm;
  const [foundU, foundV] = radialCoords(match.center, axis);
  const [declaredU, declaredV] = radialCoords(declaredCenter, axis);
  if (Math.abs(foundU - declaredU) > radialTolerance || Math.abs(foundV - declaredV) > radialTolerance) {
    return false;
  }

  const axialEdgeToleranceMm = 1;
  const foundAxialCenter = match.center[axis];
  const halfSpan = match.evidence.axialLengthMm / 2 + axialEdgeToleranceMm;
  const declaredAxial = declaredCenter[axis];
  return Math.abs(declaredAxial - foundAxialCenter) <= halfSpan;
}

export interface RadialMatchResult {
  /** Every recognized region whose fitted axis is `axis` and whose fitted center matches `declaredCenter`. Zero or 2+ means refuse (see `../editor/proof.ts`). */
  matches: CylinderInspection[];
  /** Diagnostic for the PR/tests: total faces grown across every seed. Bounded by `mesh.triangles.length` (see module header). */
  facesVisited: number;
}

/**
 * Scans `mesh` for circular regions matching a declared radial binding's
 * `axis` (already resolved to a principal axis — see
 * `regionGrowth.ts`'s `principalAxisOf`) and `declaredCenter`, seeding only
 * from axis-perpendicular, plausibly-radiused faces rather than segmenting
 * the whole mesh. See the module header for the runtime bound and the one
 * documented exception.
 */
export function findRadialMatches(mesh: WeldedMesh, declaredCenter: Vec3, axis: Axis): RadialMatchResult {
  const threshold = INSPECTION_THRESHOLDS.maxAxialNormalComponent;
  const maxPlausibleRadius = boundingRadius(mesh);
  const assigned = new Uint8Array(mesh.triangles.length);
  const matches: CylinderInspection[] = [];
  let facesVisited = 0;

  for (let t = 0; t < mesh.triangles.length; t++) {
    if (assigned[t]) continue;

    const normal = mesh.faceNormals[t];
    if (Math.abs(vecAxis(normal, axis)) > threshold) continue;

    const centroid = triangleCentroid(mesh, t);
    const dist = distanceToAxisLine(centroid, declaredCenter, axis);
    if (!Number.isFinite(dist) || dist <= 0 || dist > maxPlausibleRadius) continue;

    const region = growRegion(mesh, t, axis, INSPECTION_THRESHOLDS.maxFacetStepDeg);
    for (const r of region) assigned[r] = 1;
    facesVisited += region.length;

    const outcome = evaluateSeedRegion(mesh, t, region, axis);
    if (outcome.status === "recognized" && matchesDeclaredBinding(outcome.inspection, declaredCenter, axis)) {
      matches.push(outcome.inspection);
    }
  }

  return { matches, facesVisited };
}

/**
 * Mirrors `regionGrowth.ts`'s `recognizeRegion` body, except `axis` is the
 * DECLARED axis (fixed by the caller) rather than one discovered from the
 * seed triangle's own normal via `selectAxis` — a legitimate bore's seed
 * normal is already known perpendicular to the declared axis (that's the
 * candidate filter above), but `selectAxis` could occasionally pick a
 * different axis for a near-diagonal normal; pinning the axis here keeps
 * every grown region and fit consistent with the binding actually being
 * checked.
 */
function evaluateSeedRegion(mesh: WeldedMesh, seed: number, region: readonly number[], axis: Axis): InspectionOutcome {
  if (normalSpreadDeg(mesh, region) < INSPECTION_THRESHOLDS.maxFacetStepDeg) {
    return coarsePolygonOrPlanar(mesh, seed, axis);
  }
  const { vertices, normals } = regionVerticesAndNormals(mesh, region);
  const evaluated = evaluateCylinder(axis, vertices, normals);
  if ("code" in evaluated) {
    return { status: "refused", refusal: evaluated };
  }
  return { status: "recognized", inspection: evaluated, regionTriangles: Uint32Array.from(region) };
}
