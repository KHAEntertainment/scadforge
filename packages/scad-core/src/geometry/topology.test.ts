// @scadforge/scad-core — topology.ts tests (Issue #91, S3-B ticket B5,
// correction C2: additive builder, does not change weldTriangleSoup).
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildTopology } from "./topology.js";

describe("buildTopology", () => {
  it("parses positions and one triangle's face normal from vertProperties/triVerts", () => {
    // A single triangle in the XY plane: (0,0,0), (1,0,0), (0,1,0) -- normal +Z by the right-hand rule.
    const welded = {
      numProp: 3 as const,
      vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triVerts: new Uint32Array([0, 1, 2])
    };
    const mesh = buildTopology(welded);
    expect(mesh.positions).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }
    ]);
    expect(mesh.triangles).toEqual([[0, 1, 2]]);
    expect(mesh.faceNormals[0].x).toBeCloseTo(0, 9);
    expect(mesh.faceNormals[0].y).toBeCloseTo(0, 9);
    expect(mesh.faceNormals[0].z).toBeCloseTo(1, 9);
    expect(mesh.neighbors).toEqual([[]]); // isolated triangle, no shared edges
  });

  it("computes mutual adjacency for two triangles sharing an edge", () => {
    // A quad (0,0)-(1,0)-(1,1)-(0,1) split into 2 triangles sharing the (1,0)-(0,1) diagonal edge.
    const welded = {
      numProp: 3 as const,
      vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      triVerts: new Uint32Array([0, 1, 2, 0, 2, 3])
    };
    const mesh = buildTopology(welded);
    expect(mesh.triangles.length).toBe(2);
    expect(mesh.neighbors[0]).toContain(1);
    expect(mesh.neighbors[1]).toContain(0);
  });

  it("does not mutate its input buffers", () => {
    const vertProperties = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const triVerts = new Uint32Array([0, 1, 2]);
    const before = [...vertProperties];
    buildTopology({ numProp: 3, vertProperties, triVerts });
    expect([...vertProperties]).toEqual(before);
  });
});
