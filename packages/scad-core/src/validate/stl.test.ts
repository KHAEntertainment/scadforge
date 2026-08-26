import { describe, expect, it } from "vitest";
import { ScadForgeError } from "../errors.js";
import { buildBinaryStl } from "../test-support/stl-fixtures.js";
import { parseStl, type Triangle } from "./stl.js";

const oneTriangle: Triangle = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0]
];

const asciiStl = `solid test
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid test
`;

describe("parseStl", () => {
  it("parses a well-formed binary STL", () => {
    const triangles = parseStl(buildBinaryStl([oneTriangle, oneTriangle]));
    expect(triangles).toHaveLength(2);
    expect(triangles[0]).toEqual(oneTriangle);
  });

  it("parses a well-formed ASCII STL", () => {
    const triangles = parseStl(Buffer.from(asciiStl, "utf8"));
    expect(triangles).toHaveLength(1);
    expect(triangles[0][0]).toEqual([0, 0, 0]);
    expect(triangles[0][1]).toEqual([1, 0, 0]);
  });

  it("disambiguates a binary STL whose 80-byte header happens to start with 'solid'", () => {
    const buf = buildBinaryStl([oneTriangle]);
    buf.write("solid", 0, "ascii"); // header text collision with the ASCII marker
    const triangles = parseStl(buf);
    expect(triangles).toHaveLength(1);
    expect(triangles[0]).toEqual(oneTriangle);
  });

  // ── COUNTEREXAMPLES: malformed/malicious/boundary input, never a bare throw ──

  it("empty file -> typed MESH_PARSE_FAILED, never a bare Error/crash", () => {
    expect(() => parseStl(Buffer.alloc(0))).toThrow(ScadForgeError);
    try {
      parseStl(Buffer.alloc(0));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScadForgeError);
      expect((err as ScadForgeError).error_code).toBe("MESH_PARSE_FAILED");
    }
  });

  it("truncated binary STL (header claims more triangles than the buffer holds) -> typed error", () => {
    const buf = buildBinaryStl([oneTriangle, oneTriangle]);
    const truncated = buf.subarray(0, buf.length - 10); // chop off the tail
    expect(() => parseStl(truncated)).toThrow(ScadForgeError);
  });

  it("ASCII STL with no triangles at all -> typed error, not an empty silent success", () => {
    expect(() => parseStl(Buffer.from("solid empty\nendsolid empty\n", "utf8"))).toThrow(ScadForgeError);
  });

  it("garbage bytes that are neither ASCII nor a plausible binary STL -> typed error", () => {
    const garbage = Buffer.from("this is not an stl file at all, just some text\n".repeat(3), "utf8");
    expect(() => parseStl(garbage)).toThrow(ScadForgeError);
  });

  it("zero-triangle binary STL is accepted as a (degenerate) empty mesh, not a crash", () => {
    const triangles = parseStl(buildBinaryStl([]));
    expect(triangles).toEqual([]);
  });
});
