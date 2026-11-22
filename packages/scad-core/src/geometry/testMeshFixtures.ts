// @scadforge/scad-core — test-only mesh fixture builders shared by
// regionGrowth.test.ts and radialMatch.test.ts (Issue #91, S3-B ticket B5).
//
// Builds actual indexed/adjacent `WeldedMesh` fixtures (unlike
// cylinderFit.test.ts's raw vertex/normal lists, which don't need
// connectivity) — region growth needs real triangle adjacency to walk.
//
// SPDX-License-Identifier: Apache-2.0

import type { Axis, Vec3 } from "./vec.js";
import { buildAdjacency, dot, faceNormal, type Triangle, type WeldedMesh } from "./mesh.js";

const TAU = Math.PI * 2;

function fromUV(axis: Axis, u: number, v: number, axial: number): Vec3 {
  switch (axis) {
    case "x":
      return { x: axial, y: u, z: v };
    case "y":
      return { x: v, y: axial, z: u };
    case "z":
      return { x: u, y: v, z: axial };
  }
}

function radialDirection(axis: Axis, p: Vec3, center: [number, number]): Vec3 {
  switch (axis) {
    case "x":
      return { x: 0, y: p.y - center[0], z: p.z - center[1] };
    case "y":
      return { x: p.x - center[1], y: 0, z: p.z - center[0] };
    case "z":
      return { x: p.x - center[0], y: p.y - center[1], z: 0 };
  }
}

/**
 * An axis-aligned open-ended cylindrical wall (2 axial rows × `fn` facets,
 * 2 triangles/facet), welded so adjacent facets share vertices/edges — a
 * bore (`orientation: "hole"`) or an outer wall (`"outside"`). Winding is
 * corrected per-face against the known radial direction so the caller never
 * has to reason about triangle order by hand.
 */
export function buildTubeMesh(
  axis: Axis,
  center: [number, number],
  radius: number,
  fn: number,
  axialValues: [number, number],
  orientation: "hole" | "outside" = "outside"
): WeldedMesh {
  const positions: Vec3[] = [];
  const grid: number[][] = [[], []];
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < fn; i++) {
      const angle = (i / fn) * TAU;
      const u = center[0] + radius * Math.cos(angle);
      const v = center[1] + radius * Math.sin(angle);
      positions.push(fromUV(axis, u, v, axialValues[row]));
      grid[row].push(positions.length - 1);
    }
  }

  const wantOutward = orientation === "outside";
  const orient = (i0: number, i1: number, i2: number): Triangle => {
    const n = faceNormal(positions[i0], positions[i1], positions[i2]);
    const mid = { x: (positions[i0].x + positions[i1].x + positions[i2].x) / 3, y: (positions[i0].y + positions[i1].y + positions[i2].y) / 3, z: (positions[i0].z + positions[i1].z + positions[i2].z) / 3 };
    const outward = dot(n, radialDirection(axis, mid, center)) > 0;
    return outward === wantOutward ? [i0, i1, i2] : [i0, i2, i1];
  };

  const triangles: Triangle[] = [];
  for (let i = 0; i < fn; i++) {
    const iNext = (i + 1) % fn;
    const a = grid[0][i];
    const b = grid[0][iNext];
    const c = grid[1][i];
    const d = grid[1][iNext];
    triangles.push(orient(a, b, c));
    triangles.push(orient(b, d, c));
  }

  const faceNormals = triangles.map(([a, b, c]) => faceNormal(positions[a], positions[b], positions[c]));
  const neighbors = buildAdjacency(triangles);
  return { positions, triangles, faceNormals, neighbors };
}

/** A single flat axis-aligned quad (2 triangles), for planar-refusal fixtures. Normal points along `+axis`. */
export function buildFlatQuadMesh(axis: Axis, axialValue: number, uRange: [number, number], vRange: [number, number]): WeldedMesh {
  const corners: [number, number][] = [
    [uRange[0], vRange[0]],
    [uRange[1], vRange[0]],
    [uRange[1], vRange[1]],
    [uRange[0], vRange[1]]
  ];
  const positions = corners.map(([u, v]) => fromUV(axis, u, v, axialValue));
  let triangles: Triangle[] = [
    [0, 1, 2],
    [0, 2, 3]
  ];
  // Orient so the normal points along +axis (arbitrary but deterministic; planar
  // classification does not depend on which way a flat surface's normal points).
  const n0 = faceNormal(positions[0], positions[1], positions[2]);
  if (n0[axis] < 0) triangles = triangles.map(([a, b, c]): Triangle => [a, c, b]);
  const faceNormals = triangles.map(([a, b, c]) => faceNormal(positions[a], positions[b], positions[c]));
  const neighbors = buildAdjacency(triangles);
  return { positions, triangles, faceNormals, neighbors };
}

/** Merge several `WeldedMesh` fixtures into one, for multi-feature scenes (e.g. two bores in the same part). Positions/triangles are simply concatenated with indices offset — fixtures built independently never share welded vertices, which is fine for these tests (region growth never crosses a gap with no shared edge). */
export function mergeMeshes(...meshes: WeldedMesh[]): WeldedMesh {
  const positions: Vec3[] = [];
  const triangles: Triangle[] = [];
  const faceNormals: Vec3[] = [];
  for (const mesh of meshes) {
    const offset = positions.length;
    positions.push(...mesh.positions);
    faceNormals.push(...mesh.faceNormals);
    for (const [a, b, c] of mesh.triangles) triangles.push([a + offset, b + offset, c + offset]);
  }
  const neighbors = buildAdjacency(triangles);
  return { positions, triangles, faceNormals, neighbors };
}
