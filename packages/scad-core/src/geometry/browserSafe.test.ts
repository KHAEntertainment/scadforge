// @scadforge/scad-core — static safety test for the browser-facing
// `./geometry` package export (Issue #91, S3-B ticket B5, correction C1).
//
// `package.json`'s `./geometry` export must never pull `node:child_process`,
// `node:fs` or any other Node builtin into a browser bundle. Rather than
// asserting this only via a manual grep in the PR description, this walks
// every source file under `geometry/` (every one of them, not only those
// currently reachable from `index.ts` — a future file added here without
// being wired into the barrel yet must still hold this invariant) and
// statically asserts: no import/export specifier is a `node:` builtin, and
// no relative specifier escapes this directory (which would reach
// `../runner/**`, `../store/**` or `../validate/**`).
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const GEOMETRY_DIR = dirname(fileURLToPath(import.meta.url));

// Matches both `import ... from "spec"` and `export ... from "spec"`
// (static and type-only forms), which is everything module resolution
// could possibly follow. Dynamic `import("spec")` is intentionally also
// covered by the leading `(?:import|export)` alternation reading `import(`.
const IMPORT_SPECIFIER_RE = /\b(?:import|export)\b[^'";]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g;

function listGeometrySourceFiles(): string[] {
  return readdirSync(GEOMETRY_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => join(GEOMETRY_DIR, entry.name));
}

function importSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IMPORT_SPECIFIER_RE.exec(source)) !== null) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

describe("geometry/ is safe for the browser-facing package export (C1)", () => {
  const files = listGeometrySourceFiles();

  it("found at least the expected geometry source files (sanity check the walk itself runs)", () => {
    const names = files.map((f) => f.split("/").pop());
    expect(names).toEqual(expect.arrayContaining(["index.ts", "cylinderFit.ts", "regionGrowth.ts", "mesh.ts"]));
  });

  it.each(listGeometrySourceFiles())("%s imports no node: builtin", (filePath) => {
    const specifiers = importSpecifiers(filePath);
    const nodeBuiltins = specifiers.filter((s) => s.startsWith("node:"));
    expect(nodeBuiltins).toEqual([]);
  });

  it.each(listGeometrySourceFiles())("%s imports nothing outside geometry/ (no ../runner, ../store, ../validate, or package-root escape)", (filePath) => {
    const specifiers = importSpecifiers(filePath);
    const escaping = specifiers.filter((s) => s.startsWith("../") || s.startsWith("./../"));
    expect(escaping).toEqual([]);
  });
});
