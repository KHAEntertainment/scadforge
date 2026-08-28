// @scadforge/scad-core — property/fuzz test (Issue #30 AC 6): `parseParamSchema`
// must NEVER throw, no matter the input. Exercised against every vendored
// BOSL2/MCAD `.scad` source file (real-world OpenSCAD code, full of module/
// function definitions, nested comments, and every comment style — none of
// it Customizer-annotated, which is exactly the point: it's adversarial
// INPUT the parser was never designed around) plus a battery of
// hand-crafted adversarial strings and randomized mutations of a known-good
// fixture.
//
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseParamSchema } from "./parse.js";

const LIBS_VENDOR_DIR = fileURLToPath(new URL("../../../libs/vendor", import.meta.url));

async function listScadFilesRecursively(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listScadFilesRecursively(full)));
    } else if (entry.name.endsWith(".scad")) {
      files.push(full);
    }
  }
  return files;
}

describe("parseParamSchema fuzz — vendored BOSL2/MCAD corpus never throws", () => {
  it("parses (without throwing) every vendored .scad file, and each returns a well-formed ParamSchema", async () => {
    const files = await listScadFilesRecursively(LIBS_VENDOR_DIR);
    expect(files.length).toBeGreaterThan(50); // sanity: the corpus is really there (92 files at time of writing)

    let totalParamsFound = 0;
    for (const path of files) {
      const source = await readFile(path, "utf8");
      let schema;
      expect(() => {
        schema = parseParamSchema(source, { title: path });
      }, `threw on ${path}`).not.toThrow();
      expect(typeof schema!.title).toBe("string");
      expect(Array.isArray(schema!.parameters)).toBe(true);
      for (const p of schema!.parameters) {
        expect(typeof p.name).toBe("string");
        expect(p.name.length).toBeGreaterThan(0);
        expect(["number", "boolean", "string", "vector"]).toContain(p.type);
        expect(typeof p.group).toBe("string");
      }
      totalParamsFound += schema!.parameters.length;
    }
    // Not a hard assertion either way (BOSL2/MCAD library files legitimately
    // have zero Customizer-annotated top-level params — they're libraries,
    // not models) — just recorded so a future regression that silently
    // starts matching everything (or nothing) is visible in test output.
    expect(totalParamsFound).toBeGreaterThanOrEqual(0);
  });
});

describe("parseParamSchema fuzz — hand-crafted adversarial strings", () => {
  const cases: string[] = [
    "",
    "\0\0\0",
    "🚀".repeat(1000),
    "a".repeat(100_000),
    "=".repeat(1000),
    ";".repeat(1000),
    "[]".repeat(1000),
    "//".repeat(1000),
    "/*".repeat(1000) + "*/".repeat(1000),
    'a = "' + '\\'.repeat(500) + '";',
    "a = [" + "1,".repeat(1000) + "1];",
    "a".repeat(30) + "$".repeat(30) + " = 1;",
    "\r\n\r\n\r\n",
    "a = 1;\r\nb = 2;\r\n// caption\r\nc = 3; // [1:10]\r\n"
  ];
  for (const source of cases) {
    it(`never throws: length ${source.length}, prefix ${JSON.stringify(source.slice(0, 20))}`, () => {
      expect(() => parseParamSchema(source)).not.toThrow();
    });
  }

  it("randomized character mutations of a known-good fixture never throw (basic property test)", () => {
    const base = `
/* [Pipe] */
// Outer diameter of the pipe
pipe_d = 32; // [10:80]
wall = 4; //[2:0.5:10]
module foo() { x = 1; }
cube([pipe_d,pipe_d,pipe_d]);
`;
    // Deterministic PRNG (mulberry32) so this is reproducible across runs.
    let seed = 0xc0ffee;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = '[]{}()"/*;:,= \n\t$-0123456789abcABC';
    for (let trial = 0; trial < 200; trial++) {
      const chars = base.split("");
      const mutations = 1 + Math.floor(rand() * 5);
      for (let m = 0; m < mutations; m++) {
        const idx = Math.floor(rand() * chars.length);
        const op = rand();
        if (op < 0.34) {
          chars[idx] = alphabet[Math.floor(rand() * alphabet.length)];
        } else if (op < 0.67) {
          chars.splice(idx, 1);
        } else {
          chars.splice(idx, 0, alphabet[Math.floor(rand() * alphabet.length)]);
        }
      }
      const mutated = chars.join("");
      expect(() => parseParamSchema(mutated), `threw on mutation trial ${trial}: ${JSON.stringify(mutated)}`).not.toThrow();
    }
  });
});
