// Spike 3 — binary-STL mesh stats. Deliberately dependency-free.
// Depth (manifold-3d, 3MF parsing) is Spike 4's job (#6); this proves the
// tool-result *shape* that `validate_mesh` must return, plus enough real signal
// (component count, edge manifoldness) to catch a disconnected/floating part.
import { readFile } from 'node:fs/promises';

const WELD = 1e-4; // mm quantisation for vertex welding

function key(x, y, z) {
  const q = (v) => Math.round(v / WELD);
  return `${q(x)},${q(y)},${q(z)}`;
}

export async function analyzeStl(stlPath) {
  const buf = await readFile(stlPath);
  if (buf.length < 84) throw new Error('STL too short');
  const triCount = buf.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  if (buf.length < expected) throw new Error(`STL truncated: want ${expected}, got ${buf.length}`);

  const vertIndex = new Map();
  const verts = [];
  const tris = new Array(triCount);
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let volume6 = 0;
  let area2 = 0;
  let degenerate = 0;

  for (let i = 0; i < triCount; i++) {
    const off = 84 + i * 50 + 12; // skip normal
    const p = [];
    for (let v = 0; v < 3; v++) {
      const b = off + v * 12;
      const x = buf.readFloatLE(b), y = buf.readFloatLE(b + 4), z = buf.readFloatLE(b + 8);
      p.push([x, y, z]);
      if (x < bbox.min[0]) bbox.min[0] = x; if (x > bbox.max[0]) bbox.max[0] = x;
      if (y < bbox.min[1]) bbox.min[1] = y; if (y > bbox.max[1]) bbox.max[1] = y;
      if (z < bbox.min[2]) bbox.min[2] = z; if (z > bbox.max[2]) bbox.max[2] = z;
    }
    const [a, b2, c] = p;
    // signed volume of tetra (origin, a, b, c) * 6
    volume6 +=
      a[0] * (b2[1] * c[2] - b2[2] * c[1]) -
      a[1] * (b2[0] * c[2] - b2[2] * c[0]) +
      a[2] * (b2[0] * c[1] - b2[1] * c[0]);
    const u = [b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const mag = Math.hypot(n[0], n[1], n[2]);
    area2 += mag;
    if (mag < 1e-12) degenerate++;

    const idx = p.map(([x, y, z]) => {
      const k = key(x, y, z);
      let id = vertIndex.get(k);
      if (id === undefined) { id = verts.length; vertIndex.set(k, id); verts.push([x, y, z]); }
      return id;
    });
    tris[i] = idx;
  }

  // --- edge manifoldness: every undirected edge must be used exactly twice,
  //     and (for a consistently oriented closed surface) once in each direction.
  const edgeUse = new Map();
  let flipped = 0;
  for (const [a, b, c] of tris) {
    for (const [p0, p1] of [[a, b], [b, c], [c, a]]) {
      if (p0 === p1) continue;
      const lo = Math.min(p0, p1), hi = Math.max(p0, p1);
      const k = `${lo}_${hi}`;
      const e = edgeUse.get(k) ?? { fwd: 0, rev: 0 };
      if (p0 === lo) e.fwd++; else e.rev++;
      edgeUse.set(k, e);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0;
  for (const e of edgeUse.values()) {
    const n = e.fwd + e.rev;
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
    else if (n === 2 && (e.fwd === 2 || e.rev === 2)) flipped++;
  }

  // --- connected components over welded vertices (union-find)
  const parent = new Int32Array(verts.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; };
  for (const [a, b, c] of tris) { union(a, b); union(b, c); }
  const roots = new Set();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));
  const components = roots.size;

  const warnings = [];
  if (boundaryEdges > 0) warnings.push(`${boundaryEdges} boundary (open) edges — mesh is not watertight`);
  if (nonManifoldEdges > 0) warnings.push(`${nonManifoldEdges} non-manifold edges (shared by >2 faces)`);
  if (flipped > 0) warnings.push(`${flipped} edges with inconsistent winding`);
  if (degenerate > 0) warnings.push(`${degenerate} degenerate (zero-area) triangles`);
  if (components > 1) {
    warnings.push(
      `mesh has ${components} disconnected solid components — parts of the model are not fused ` +
      `(a floating/detached feature, or intentionally separate pieces)`,
    );
  }
  if (triCount === 0) warnings.push('mesh is empty — geometry evaluated to nothing');

  const size = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
  const r3 = (n) => Math.round(n * 1000) / 1000;

  return {
    manifold: boundaryEdges === 0 && nonManifoldEdges === 0 && flipped === 0 && triCount > 0,
    watertight: boundaryEdges === 0 && triCount > 0,
    volume_mm3: r3(Math.abs(volume6) / 6),
    surface_area_mm2: r3(area2 / 2),
    bbox_mm: { min: bbox.min.map(r3), max: bbox.max.map(r3), size: size.map(r3) },
    triangle_count: triCount,
    vertex_count: verts.length,
    components,
    boundary_edges: boundaryEdges,
    non_manifold_edges: nonManifoldEdges,
    degenerate_triangles: degenerate,
    warnings,
  };
}
