// Hand-constructs a deliberately non-manifold / open mesh: a 20mm cube with
// the top face (z=20) removed. Result: 10 triangles instead of 12, with a
// 4-edge open boundary loop at z=20 — not watertight, not manifold.
// Written as ASCII STL for human-readability/auditability of the "broken" fixture.
import { writeFileSync } from 'node:fs';

const S = 20; // mm
const V = {
  a: [0, 0, 0], b: [S, 0, 0], c: [S, S, 0], d: [0, S, 0], // bottom z=0
  e: [0, 0, S], f: [S, 0, S], g: [S, S, S], h: [0, S, S], // top z=S (left unconnected on purpose)
};

// Each face as two triangles, outward-facing winding order.
// Bottom (z=0), 4 sides. Top face is intentionally OMITTED.
const faces = [
  // bottom (normal -Z)
  [V.a, V.c, V.b], [V.a, V.d, V.c],
  // front (y=0, normal -Y)
  [V.a, V.b, V.f], [V.a, V.f, V.e],
  // right (x=S, normal +X)
  [V.b, V.c, V.g], [V.b, V.g, V.f],
  // back (y=S, normal +Y)
  [V.c, V.d, V.h], [V.c, V.h, V.g],
  // left (x=0, normal -X)
  [V.d, V.a, V.e], [V.d, V.e, V.h],
  // top face deliberately missing -> open boundary loop e-f-g-h
];

function normal([p0, p1, p2]) {
  const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const n = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const len = Math.hypot(...n) || 1;
  return n.map((x) => x / len);
}

let out = 'solid bad-mesh-open-top\n';
for (const tri of faces) {
  const n = normal(tri);
  out += `  facet normal ${n[0]} ${n[1]} ${n[2]}\n`;
  out += '    outer loop\n';
  for (const p of tri) {
    out += `      vertex ${p[0]} ${p[1]} ${p[2]}\n`;
  }
  out += '    endloop\n';
  out += '  endfacet\n';
}
out += 'endsolid bad-mesh-open-top\n';

writeFileSync(new URL('./bad-mesh.stl', import.meta.url), out);
console.log(`Wrote bad-mesh.stl with ${faces.length} triangles (12 expected for a closed cube).`);
