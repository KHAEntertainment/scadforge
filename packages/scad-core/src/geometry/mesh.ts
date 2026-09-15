// @scadforge/scad-core — welded-mesh topology primitives shared by the web
// three.js bridge (`apps/web/src/components/inspect/surfaceRegion.ts`) and
// this package's STL-based topology builder (`topology.ts`), ported from
// apps/web/src/components/inspect/surfaceRegion.ts:22-105 (Issue #91, S3-B
// ticket B5).
//
// No three.js, no Node builtins — safe for the browser-facing `./geometry`
// package export as well as this package's own server-side use.
//
// SPDX-License-Identifier: Apache-2.0

import type { Vec3 } from "./vec.js";

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Angle between two (assumed unit) vectors, in degrees. Clamps the dot product against float noise pushing it just outside [-1, 1]. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const clamped = Math.min(1, Math.max(-1, dot(a, b)));
  return (Math.acos(clamped) * 180) / Math.PI;
}

export function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}

export type Triangle = readonly [number, number, number];

export interface WeldedMesh {
  /** Welded (deduplicated) vertex positions. */
  positions: Vec3[];
  /** One entry per displayed triangle, in displayed order: the three welded vertex indices. */
  triangles: Triangle[];
  /** One entry per displayed triangle, in displayed order: its face normal, computed from welded positions. */
  faceNormals: Vec3[];
  /** Edge-adjacency: for triangle i, the triangle indices sharing an edge with it. */
  neighbors: number[][];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Edge-adjacency from welded triangle indices: for triangle i, the triangle
 * indices sharing an edge with it. A shared edge normally borders exactly 2
 * triangles. A boundary edge (1 triangle) has no neighbor across it; a
 * non-manifold edge (3+, e.g. a T-junction) links every triangle that
 * touches it.
 */
export function buildAdjacency(triangles: readonly Triangle[]): number[][] {
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
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i !== j) neighbors[list[i]].push(list[j]);
      }
    }
  }
  return neighbors;
}
