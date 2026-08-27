// @scadforge/scad-core — dependency-free binary + ASCII STL reader.
//
// Reimplemented production-grade from Spike 4's `lib/stl.mjs` reference
// (docs/spikes/04-manifold-validate); not imported from spikes/. Returns raw
// triangle soup (no shared-vertex topology) — welding happens in
// `mesh-utils.ts`, matching Spike 4's INPUT FORMAT DECISION (parallel binary
// STL export, not 3MF parsing, to keep this GPL-free package dependency-free).
//
// SPDX-License-Identifier: Apache-2.0

import { ScadForgeError } from "../errors.js";

/** One vertex, `[x, y, z]` in mm. */
export type Vertex = readonly [number, number, number];
/** One triangle, three vertices in file order/winding. */
export type Triangle = readonly [Vertex, Vertex, Vertex];

const BINARY_STL_HEADER_BYTES = 80;
const BINARY_STL_TRIANGLE_BYTES = 50; // 12 (normal) + 3*12 (vertices) + 2 (attribute byte count)

function looksLikeAsciiHeader(buf: Buffer): boolean {
  if (buf.length < 5) return false;
  return buf.subarray(0, 5).toString("ascii").toLowerCase() === "solid";
}

function parseAsciiStl(text: string): Triangle[] {
  const triangles: Triangle[] = [];
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match: RegExpExecArray | null;
  let current: Vertex[] = [];
  while ((match = vertexRe.exec(text)) !== null) {
    current.push([Number.parseFloat(match[1]), Number.parseFloat(match[2]), Number.parseFloat(match[3])]);
    if (current.length === 3) {
      triangles.push(current as unknown as Triangle);
      current = [];
    }
  }
  if (triangles.length === 0) {
    throw new ScadForgeError("MESH_PARSE_FAILED", "ASCII STL contains no triangles (empty or truncated mesh)");
  }
  return triangles;
}

function parseBinaryStl(buf: Buffer): Triangle[] {
  if (buf.length < BINARY_STL_HEADER_BYTES + 4) {
    throw new ScadForgeError("MESH_PARSE_FAILED", `binary STL too small to contain a header: ${buf.length} bytes`);
  }
  const triCount = buf.readUInt32LE(BINARY_STL_HEADER_BYTES);
  const expectedSize = BINARY_STL_HEADER_BYTES + 4 + triCount * BINARY_STL_TRIANGLE_BYTES;
  if (buf.length < expectedSize) {
    throw new ScadForgeError(
      "MESH_PARSE_FAILED",
      `binary STL size mismatch: header claims ${triCount} triangles (expects ${expectedSize} bytes) but file is ${buf.length} bytes`
    );
  }
  const triangles: Triangle[] = [];
  let offset = BINARY_STL_HEADER_BYTES + 4;
  for (let i = 0; i < triCount; i++) {
    offset += 12; // skip normal (3 floats) -- recomputed by the consumer, not trusted
    const verts: Vertex[] = [];
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(offset);
      const y = buf.readFloatLE(offset + 4);
      const z = buf.readFloatLE(offset + 8);
      verts.push([x, y, z]);
      offset += 12;
    }
    triangles.push(verts as unknown as Triangle);
    offset += 2; // skip attribute byte count
  }
  return triangles;
}

/**
 * Parses a binary or ASCII STL buffer into raw triangle soup. Never throws a
 * bare Error — malformed/truncated/empty input raises a typed
 * `ScadForgeError('MESH_PARSE_FAILED', ...)`.
 */
export function parseStl(buf: Buffer): Triangle[] {
  if (buf.length === 0) {
    throw new ScadForgeError("MESH_PARSE_FAILED", "mesh file is empty (0 bytes)");
  }

  const asciiHeader = looksLikeAsciiHeader(buf);
  if (asciiHeader && buf.length < BINARY_STL_HEADER_BYTES + 4 + BINARY_STL_TRIANGLE_BYTES) {
    // Too small to plausibly be binary with even 1 triangle; must be ASCII.
    return parseAsciiStl(buf.toString("utf8"));
  }
  if (asciiHeader) {
    // Ambiguous: a binary header may coincidentally start with "solid" text.
    // Trust binary only when the declared triangle count matches file size exactly.
    const triCount = buf.readUInt32LE(BINARY_STL_HEADER_BYTES);
    if (buf.length === BINARY_STL_HEADER_BYTES + 4 + triCount * BINARY_STL_TRIANGLE_BYTES) {
      return parseBinaryStl(buf);
    }
    return parseAsciiStl(buf.toString("utf8"));
  }
  return parseBinaryStl(buf);
}
