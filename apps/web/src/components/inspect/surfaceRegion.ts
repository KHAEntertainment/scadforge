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
import { evaluateCylinder } from "./cylinderFit.js";
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
  return { positions, triangles, faceNormals, neighbors };
}

function getWeldedMesh(geometry: BufferGeometry): WeldedMesh {
  const cached = weldCache.get(geometry);
  if (cached) return cached;
  const built = buildWeldedMesh(geometry);
  weldCache.set(geometry, built);
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
 * was reached from is at most `maxFacetStepDeg`. Growth naturally stops
 * at end caps (normal no longer perpendicular to the axis), sharp edges
 * (angle too large) and boolean seams (the far side's normal fails
 * either check) — no special-casing needed for any of them.
 *
 * Also reports the smallest angle of any neighbor that was otherwise
 * perpendicular to the axis but rejected purely for exceeding
 * `maxFacetStepDeg` — evidence of a coarser polygon just beyond the
 * region's edge (a hex boss's 60° facet-to-facet step, say). `null`
 * means growth exhausted every axis-perpendicular neighbor without ever
 * hitting that ceiling, i.e. the region's boundary is a genuine
 * end/cap/seam, not a step too coarse to admit.
 */
function growRegion(mesh: WeldedMesh, seedTriangle: number, axis: Axis): { triangles: number[]; minRejectedStepDeg: number | null } {
  const threshold = INSPECTION_THRESHOLDS.maxAxialNormalComponent;
  const visited = new Set<number>([seedTriangle]);
  const queue: number[] = [seedTriangle];
  let minRejectedStepDeg: number | null = null;

  while (queue.length > 0) {
    const current = queue.shift() as number;
    const currentNormal = mesh.faceNormals[current];
    for (const neighbor of mesh.neighbors[current]) {
      if (visited.has(neighbor)) continue;
      const neighborNormal = mesh.faceNormals[neighbor];
      if (Math.abs(vecAxis(neighborNormal, axis)) > threshold) continue;
      const step = angleBetweenDeg(currentNormal, neighborNormal);
      if (step > INSPECTION_THRESHOLDS.maxFacetStepDeg) {
        if (minRejectedStepDeg === null || step < minRejectedStepDeg) minRejectedStepDeg = step;
        continue;
      }
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }

  return { triangles: Array.from(visited), minRejectedStepDeg };
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
  const { triangles: regionTriangleIndices, minRejectedStepDeg } = growRegion(mesh, triangleIndex, axis);

  // Growth was blocked by a facet step too coarse to admit (not by
  // running out of axis-perpendicular neighbors): that is itself
  // evidence of a polygonal prism, not a flat surface. Refusing
  // too-coarse here, before the circle fit, matters because a region
  // this small (often just the seed facet, i.e. two points once
  // projected) makes the fit singular -- indistinguishable, to the fit
  // alone, from a genuinely flat region.
  if (minRejectedStepDeg !== null) {
    const estimatedSegments = Math.round(360 / minRejectedStepDeg);
    if (estimatedSegments < INSPECTION_THRESHOLDS.minSegments) {
      return { status: "refused", refusal: tooCoarseRefusal(estimatedSegments) };
    }
  }

  if (normalSpreadDeg(mesh, regionTriangleIndices) < INSPECTION_THRESHOLDS.maxFacetStepDeg) {
    // The region's normals barely vary -- a flat or chamfered strip
    // that happens to be perpendicular to an axis, not a curved wall.
    return { status: "refused", refusal: planarRefusal() };
  }

  const { vertices, normals } = regionVerticesAndNormals(mesh, regionTriangleIndices);
  const outcome = evaluateCylinder(axis, vertices, normals);

  if ("code" in outcome) {
    return { status: "refused", refusal: outcome };
  }

  const regionTriangles = Uint32Array.from(regionTriangleIndices);
  return { status: "recognized", inspection: outcome, regionTriangles };
}
