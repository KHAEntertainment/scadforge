// @scadforge/scad-core — vertex welding: STL triangle-soup → indexed
// vertex/triangle buffers suitable for manifold-3d's `Mesh` input.
//
// Reimplemented production-grade from Spike 4's `lib/mesh-utils.mjs`
// reference; not imported from spikes/.
//
// SPDX-License-Identifier: Apache-2.0

import type { Triangle } from "./stl.js";

/** Epsilon (mm) used to merge nearly-identical vertex positions (Spike 4). */
export const WELD_EPSILON_MM = 1e-5;

export interface WeldedMesh {
  /** Always 3 (x, y, z position only — no normals/UVs). */
  numProp: 3;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  /** Triangle count BEFORE welding (present even when the mesh turns out non-manifold). */
  rawTriangleCount: number;
  weldedVertexCount: number;
}

/**
 * Welds triangle-soup vertices at (nearly) identical positions to a shared
 * index, which STL's format does not carry natively (every triangle
 * duplicates its own 3 vertices with no shared-edge info).
 */
export function weldTriangleSoup(triangles: readonly Triangle[], epsilon: number = WELD_EPSILON_MM): WeldedMesh {
  const scale = 1 / epsilon;
  const indexOf = new Map<string, number>();
  const vertProperties: number[] = [];
  const triVerts: number[] = [];

  const keyOf = (p: readonly [number, number, number]): string =>
    `${Math.round(p[0] * scale)},${Math.round(p[1] * scale)},${Math.round(p[2] * scale)}`;

  for (const tri of triangles) {
    for (const p of tri) {
      const key = keyOf(p);
      let idx = indexOf.get(key);
      if (idx === undefined) {
        idx = vertProperties.length / 3;
        indexOf.set(key, idx);
        vertProperties.push(p[0], p[1], p[2]);
      }
      triVerts.push(idx);
    }
  }

  return {
    numProp: 3,
    vertProperties: new Float32Array(vertProperties),
    triVerts: new Uint32Array(triVerts),
    rawTriangleCount: triangles.length,
    weldedVertexCount: vertProperties.length / 3
  };
}
