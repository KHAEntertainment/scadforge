/**
 * Surface region growth and the `inspectSurface` entry point (S2 scope,
 * recognition method steps 2–4). The single seam every other S2 ticket
 * calls: from a clicked triangle on the displayed STL to a recognized
 * cylinder or a refusal.
 *
 * This is the only `inspect/` module allowed to import three.js — it's
 * the bridge from `BufferGeometry` to the pure math in `cylinderFit.ts`
 * (which must stay three.js-free).
 */

import { BufferGeometry } from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Axis, Vec3 } from "../measure.js";
import { INSPECTION_THRESHOLDS } from "./thresholds.js";
import { angularStepsDeg, evaluateCylinder, fitCircleInPlane } from "./cylinderFit.js";
import { notAxisAlignedRefusal, planarRefusal, tooCoarseRefusal } from "./refusals.js";
import type { InspectionOutcome } from "./inspectionTypes.js";

const AXES: readonly Axis[] = ["x", "y", "z"];

function vecAxis(v: Vec3, axis: Axis): number {
  return v[axis];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Angle between two (assumed unit) vectors, in degrees. Clamps the dot product against float noise pushing it just outside [-1, 1]. */
function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const clamped = Math.min(1, Math.max(-1, dot(a, b)));
  return (Math.acos(clamped) * 180) / Math.PI;
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}

type Triangle = readonly [number, number, number];

interface WeldedMesh {
  /** Welded (deduplicated) vertex positions. */
  positions: Vec3[];
  /** One entry per displayed triangle, in displayed order: the three welded vertex indices. */
  triangles: Triangle[];
  /** One entry per displayed triangle, in displayed order: its face normal, computed from welded positions. */
  faceNormals: Vec3[];
  /** Edge-adjacency: for triangle i, the triangle indices sharing an edge with it. */
  neighbors: number[][];
}

const weldCache = new WeakMap<BufferGeometry, WeldedMesh>();

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function buildAdjacency(triangles: Triangle[]): number[][] {
  const edgeToTriangles = new Map<string, number[]>();
  for (let t = 0; t < triangles.length; t++) {
    const [a, b, c] = triangles[t];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a]
    ] as const) {
      const key = edgeKey(p, q);
      const list = edgeToTriangles.get(key);
      if (list) list.push(t);
      else edgeToTriangles.set(key, [t]);
    }
  }

  const neighbors: number[][] = triangles.map(() => []);
  for (const list of edgeToTriangles.values()) {
    // A shared edge normally borders exactly 2 triangles. A boundary edge
    // (1 triangle) has no neighbor across it; a non-manifold edge (3+,
    // e.g. a T-junction) links every triangle that touches it.
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i !== j) neighbors[list[i]].push(list[j]);
      }
    }
  }
  return neighbors;
}

/**
 * Weld a position-only clone of `geometry` and compute face normals from
 * the welded positions. Position-only because the STL loader attaches
 * per-face normals, and `mergeVertices` compares every attribute it
 * finds — with normals present it would never join two facets that
 * share a position but disagree on face normal, i.e. it would never
 * weld anything.
 *
 * Triangle order is preserved: `mergeVertices` walks the source
 * geometry's vertices in original order (0, 1, 2, …), so welded
 * triangle *i* is displayed triangle *i*.
 */
function buildWeldedMesh(geometry: BufferGeometry): WeldedMesh {
  const positionOnly = new BufferGeometry();
  positionOnly.setAttribute("position", geometry.getAttribute("position").clone());
  const sourceIndex = geometry.getIndex();
  if (sourceIndex) positionOnly.setIndex(sourceIndex.clone());

  const welded = mergeVertices(positionOnly);
  const weldedPositionAttr = welded.getAttribute("position");
  const weldedIndexAttr = welded.getIndex();
  if (!weldedIndexAttr) {
    throw new Error("surfaceRegion: mergeVertices did not produce an indexed geometry");
  }

  const positions: Vec3[] = [];
  for (let i = 0; i < weldedPositionAttr.count; i++) {
    positions.push({ x: weldedPositionAttr.getX(i), y: weldedPositionAttr.getY(i), z: weldedPositionAttr.getZ(i) });
  }

  const triangleCount = weldedIndexAttr.count / 3;
  const triangles: Triangle[] = [];
  const faceNormals: Vec3[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const a = weldedIndexAttr.getX(t * 3);
    const b = weldedIndexAttr.getX(t * 3 + 1);
    const c = weldedIndexAttr.getX(t * 3 + 2);
    triangles.push([a, b, c]);
    faceNormals.push(faceNormal(positions[a], positions[b], positions[c]));
  }

  const neighbors = buildAdjacency(triangles);
  positionOnly.dispose();
  welded.dispose();
  return { positions, triangles, faceNormals, neighbors };
}

function getWeldedMesh(geometry: BufferGeometry): WeldedMesh {
  const cached = weldCache.get(geometry);
  if (cached) return cached;
  const built = buildWeldedMesh(geometry);
  weldCache.set(geometry, built);
  const release = () => {
    weldCache.delete(geometry);
    geometry.removeEventListener("dispose", release);
  };
  geometry.addEventListener("dispose", release);
  return built;
}

type AxisSelection = { kind: "planar" } | { kind: "axis"; axis: Axis } | { kind: "not-axis-aligned" };

/**
 * A normal along a principal axis (its component on that axis dominates,
 * i.e. the other two components are both near zero) is a flat surface:
 * `planar`. A normal perpendicular to exactly one principal axis (that
 * axis's own component is near zero, the other two are not) selects
 * that axis as the candidate cylinder axis. Anything else — a cone, a
 * tilted cylinder, a sphere — is `not-axis-aligned`.
 */
function selectAxis(normal: Vec3): AxisSelection {
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
function growRegion(mesh: WeldedMesh, seedTriangle: number, axis: Axis, maxStepDeg: number): number[] {
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
function distinctNormalCount(mesh: WeldedMesh, regionTriangles: readonly number[]): number {
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
function normalSpreadDeg(mesh: WeldedMesh, regionTriangles: readonly number[]): number {
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
function regionVerticesAndNormals(mesh: WeldedMesh, regionTriangles: readonly number[]): { vertices: Vec3[]; normals: Vec3[] } {
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
    normals.push(normalize({ x: normal.x / count, y: normal.y / count, z: normal.z / count }));
  }
  return { vertices, normals };
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
function coarsePolygonOrPlanar(mesh: WeldedMesh, seedTriangle: number, axis: Axis): InspectionOutcome {
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
 * From a clicked triangle on the displayed STL geometry, to a
 * recognized cylinder or a refusal. Synchronous and pure with respect
 * to its inputs; the only state is the weld/adjacency cache, built
 * lazily per `geometry` and dropped with it (`WeakMap`).
 */
export function inspectSurface(geometry: BufferGeometry, triangleIndex: number): InspectionOutcome {
  const mesh = getWeldedMesh(geometry);
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
