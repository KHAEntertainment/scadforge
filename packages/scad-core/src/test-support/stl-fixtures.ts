// Test-only helpers: synthetic binary STL buffers, so validation-layer tests
// don't need a real OpenSCAD/Docker render to exercise manifold-3d.
import type { Triangle } from "../validate/stl.js";

/** Builds a binary STL buffer (80-byte header + 4-byte count + 50 bytes/triangle) from raw triangles. */
export function buildBinaryStl(triangles: Triangle[]): Buffer {
  const buf = Buffer.alloc(80 + 4 + triangles.length * 50);
  buf.write("scadforge-test-fixture", 0, "ascii");
  buf.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const tri of triangles) {
    buf.writeFloatLE(0, offset);
    buf.writeFloatLE(0, offset + 4);
    buf.writeFloatLE(0, offset + 8);
    offset += 12;
    for (const [x, y, z] of tri) {
      buf.writeFloatLE(x, offset);
      buf.writeFloatLE(y, offset + 4);
      buf.writeFloatLE(z, offset + 8);
      offset += 12;
    }
    buf.writeUInt16LE(0, offset);
    offset += 2;
  }
  return buf;
}

/** The 12 triangles of an axis-aligned cube from `[0,0,0]` to `[size,size,size]`. */
export function cubeTriangles(size: number): Triangle[] {
  const s = size;
  const p = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const v = {
    "000": p(0, 0, 0),
    "100": p(s, 0, 0),
    "110": p(s, s, 0),
    "010": p(0, s, 0),
    "001": p(0, 0, s),
    "101": p(s, 0, s),
    "111": p(s, s, s),
    "011": p(0, s, s)
  };
  const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): Triangle[] => [
    [a, b, c],
    [a, c, d]
  ];
  return [
    ...quad(v["000"], v["010"], v["110"], v["100"]), // bottom (z=0)
    ...quad(v["001"], v["101"], v["111"], v["011"]), // top (z=s)
    ...quad(v["000"], v["100"], v["101"], v["001"]), // front (y=0)
    ...quad(v["010"], v["011"], v["111"], v["110"]), // back (y=s)
    ...quad(v["000"], v["001"], v["011"], v["010"]), // left (x=0)
    ...quad(v["100"], v["110"], v["111"], v["101"]) // right (x=s)
  ];
}

/** A cube missing its top face's two triangles: 10 triangles, an open 4-edge boundary loop (not manifold). */
export function openCubeTriangles(size: number): Triangle[] {
  return cubeTriangles(size).slice(0, 10);
}

/** Translates every vertex of every triangle by `[dx, dy, dz]`. */
export function translateTriangles(triangles: readonly Triangle[], dx: number, dy: number, dz: number): Triangle[] {
  return triangles.map(
    ([a, b, c]): Triangle => [
      [a[0] + dx, a[1] + dy, a[2] + dz],
      [b[0] + dx, b[1] + dy, b[2] + dz],
      [c[0] + dx, c[1] + dy, c[2] + dz]
    ]
  );
}
