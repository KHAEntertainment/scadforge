// Converts triangle-soup (array of [p0,p1,p2], each a [x,y,z]) into an
// indexed vertex/triangle buffer suitable for manifold-3d's Mesh input, by
// welding vertices at (nearly) identical positions to a shared index.
// This is required for STL, which stores fully-duplicated per-triangle
// vertices with no shared-edge topology information.

export function weldTriangleSoup(triangles, epsilon = 1e-5) {
  const scale = 1 / epsilon;
  const keyOf = (p) => `${Math.round(p[0] * scale)},${Math.round(p[1] * scale)},${Math.round(p[2] * scale)}`;

  const indexOf = new Map();
  const vertProperties = [];
  const triVerts = [];

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
    weldedVertexCount: vertProperties.length / 3,
  };
}
