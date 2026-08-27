import { describe, expect, it } from "vitest";
import type { Triangle } from "./stl.js";
import { weldTriangleSoup, WELD_EPSILON_MM } from "./mesh-utils.js";

describe("weldTriangleSoup", () => {
  it("welds duplicated vertices from triangle soup to a shared index", () => {
    // A unit square as 2 triangles, STL-style (every vertex duplicated).
    const triangles: Triangle[] = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0]
      ],
      [
        [0, 0, 0],
        [1, 1, 0],
        [0, 1, 0]
      ]
    ];
    const welded = weldTriangleSoup(triangles);
    expect(welded.rawTriangleCount).toBe(2);
    expect(welded.weldedVertexCount).toBe(4); // 6 raw verts -> 4 unique positions
    expect(welded.triVerts).toHaveLength(6);
    expect(welded.numProp).toBe(3);
  });

  it("merges vertices within epsilon but keeps vertices outside epsilon distinct", () => {
    const justInside = WELD_EPSILON_MM / 10;
    const justOutside = WELD_EPSILON_MM * 100;
    const triangles: Triangle[] = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
      ],
      [
        [justInside, 0, 0], // should merge with [0,0,0]
        [1 + justOutside, 0, 0], // should NOT merge with [1,0,0]
        [0, 1, 0]
      ]
    ];
    const welded = weldTriangleSoup(triangles);
    // 6 raw vertices; [0,0,0]/[justInside,0,0] merge, [0,1,0] repeats across
    // both triangles, [1,0,0] and [1+justOutside,0,0] stay distinct: 4 unique.
    expect(welded.weldedVertexCount).toBe(4);
  });

  // COUNTEREXAMPLE: empty input.
  it("handles an empty triangle list without throwing", () => {
    const welded = weldTriangleSoup([]);
    expect(welded.rawTriangleCount).toBe(0);
    expect(welded.weldedVertexCount).toBe(0);
    expect(welded.triVerts).toHaveLength(0);
  });
});
