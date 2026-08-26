// Minimal, dependency-free binary + ASCII STL reader.
// Returns raw triangle soup: an array of triangles, each a [p0, p1, p2] of
// [x, y, z] numbers, in file order/winding — no dedup/merge is done here.

function isAsciiStl(buf) {
  // ASCII STL files start with the literal bytes "solid" followed by
  // whitespace/newline. Binary STL headers may also start with "solid" text
  // in the 80-byte header (some exporters do this), so this check is not
  // fully reliable in isolation -- combined with a size sanity check below.
  const head = buf.subarray(0, 5).toString('ascii').toLowerCase();
  return head === 'solid';
}

function parseAsciiStl(text) {
  const triangles = [];
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match;
  let current = [];
  while ((match = vertexRe.exec(text)) !== null) {
    current.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
    if (current.length === 3) {
      triangles.push(current);
      current = [];
    }
  }
  return triangles;
}

function parseBinaryStl(buf) {
  const triCount = buf.readUInt32LE(80);
  const expectedSize = 84 + triCount * 50;
  if (buf.length < expectedSize) {
    throw new Error(
      `Binary STL size mismatch: header claims ${triCount} triangles ` +
      `(expects ${expectedSize} bytes) but file is ${buf.length} bytes.`,
    );
  }
  const triangles = [];
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    offset += 12; // skip normal (3 floats) -- recomputed, not trusted
    const tri = [];
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(offset);
      const y = buf.readFloatLE(offset + 4);
      const z = buf.readFloatLE(offset + 8);
      tri.push([x, y, z]);
      offset += 12;
    }
    triangles.push(tri);
    offset += 2; // skip attribute byte count
  }
  return triangles;
}

export function parseStl(buf) {
  if (isAsciiStl(buf) && buf.length < 84 + 50) {
    // Too small to plausibly be binary with even 1 triangle; must be ASCII
    // (or an empty/degenerate solid).
    return parseAsciiStl(buf.toString('utf8'));
  }
  if (isAsciiStl(buf)) {
    // Could be either. Binary STL triangle count is a strong signal: if the
    // declared triangle count matches the file size exactly, trust binary.
    const triCount = buf.readUInt32LE(80);
    if (buf.length === 84 + triCount * 50) {
      return parseBinaryStl(buf);
    }
    return parseAsciiStl(buf.toString('utf8'));
  }
  return parseBinaryStl(buf);
}
