// @scadforge/scad-core — additive STL-triVerts → WeldedMesh topology builder
// (Issue #91, S3-B ticket B5, correction C2).
//
// `validate/mesh-utils.ts`'s `weldTriangleSoup` feeds mesh validation
// (`validate_mesh`) and its existing output/behaviour must not change — this
// file does not modify it, only builds on its output shape. `weldTriangleSoup`
// welds positions only (no face normals, no edge adjacency); this adds both,
// separately, for the region-growth recognizer (`regionGrowth.ts`,
// `radialMatch.ts`), which needs them and `weldTriangleSoup`'s validation
// callers do not.
//
// Deliberately structurally typed against `WeldedMesh` from
// `../validate/mesh-utils.js` rather than importing it — this file is
// server-only in practice (called from `../editor/proof.ts` on a rendered
// STL) but is not itself excluded from the browser-safe `./geometry` export;
// keeping it import-free of `../validate/**` means it can never accidentally
// pull a filesystem-touching module into that surface.
//
// SPDX-License-Identifier: Apache-2.0

import type { Vec3 } from "./vec.js";
import { buildAdjacency, faceNormal, type Triangle, type WeldedMesh } from "./mesh.js";

/** The subset of `validate/mesh-utils.ts`'s `WeldedMesh` this builder needs — positions only, matching structurally without importing that module. */
export interface WeldedPositions {
  /** Always 3 (x, y, z position only). */
  numProp: 3;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

/**
 * Adds face normals and edge adjacency to `weldTriangleSoup`'s welded
 * position/index buffers, producing the richer `WeldedMesh` shape
 * `regionGrowth.ts`'s region-growth and axis-selection functions need.
 * Pure and synchronous; does not touch `weldTriangleSoup`'s own output.
 */
export function buildTopology(welded: WeldedPositions): WeldedMesh {
  const { vertProperties, triVerts } = welded;

  const positions: Vec3[] = [];
  for (let i = 0; i < vertProperties.length / 3; i++) {
    positions.push({ x: vertProperties[i * 3], y: vertProperties[i * 3 + 1], z: vertProperties[i * 3 + 2] });
  }

  const triangleCount = triVerts.length / 3;
  const triangles: Triangle[] = [];
  const faceNormals: Vec3[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const a = triVerts[t * 3];
    const b = triVerts[t * 3 + 1];
    const c = triVerts[t * 3 + 2];
    triangles.push([a, b, c]);
    faceNormals.push(faceNormal(positions[a], positions[b], positions[c]));
  }

  const neighbors = buildAdjacency(triangles);
  return { positions, triangles, faceNormals, neighbors };
}
