// @docker -- BOSL2 library mounting. `renderViews`/`runSyntaxCheck`/etc.
// accept an explicit `libraryPaths` parameter (Issue #14: "accept a library
// path parameter -- packages/libs supplies it later"). Issue #19 has since
// vendored BOSL2 into `packages/libs/vendor/bosl2`, so this test exercises a
// real BOSL2-using model through the render pipeline against it. It still
// SKIPS gracefully (in addition to the Docker-availability skip) if no
// vendored checkout is found -- `SCADFORGE_BOSL2_PATH` overrides the path for
// local development against a different checkout.
//
// NOTE: deliberately does NOT fall back to `spikes/02-docker-cli/libs/BOSL2`
// -- CLAUDE.md hard rule 8 / PROJECT_CONTEXT.md: `spikes/` is excluded from
// the workspace and must never be depended on by product code (tests
// included). `packages/scad-core` also does not take `@scadforge/libs` as a
// package dependency here -- that package is GPL-3.0-or-later (vendored
// BOSL2/MCAD), and scad-core must stay GPL-free (CLAUDE.md hard rule 1).
// This test only reads a plain filesystem path computed at the repo-root
// level, never an `import` of `@scadforge/libs`.
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerAvailable } from "../test-support/docker-available.js";
import { renderViews } from "./render.js";
import { runSyntaxCheck } from "./syntax.js";

// src/runner/ -> src/ -> scad-core/ -> packages/ -> repo root (4 levels up).
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const candidatePaths = [
  process.env.SCADFORGE_BOSL2_PATH,
  join(repoRoot, "packages/libs/vendor/bosl2")
].filter((p): p is string => Boolean(p));

const bosl2Path = candidatePaths.find((p) => existsSync(join(p, "std.scad")));

let outDir: string;
let scadPath: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "scadcore-bosl2-out-"));
  const workDir = await mkdtemp(join(tmpdir(), "scadcore-bosl2-src-"));
  scadPath = join(workDir, "bosl2-model.scad");
  await writeFile(
    scadPath,
    ["include <bosl2/std.scad>", "cuboid([10,10,10], rounding=2, edges=\"Z\");"].join("\n"),
    "utf8"
  );
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable() || !bosl2Path)(
  "@docker BOSL2 library mounting (packages/libs/vendor/bosl2, from Issue #19)",
  () => {
    it("render_views: renders a BOSL2-using model when libraryPaths points at the vendored checkout", async () => {
      const result = await renderViews({ scadPath, outDir, views: ["iso"] }, { libraryPaths: [bosl2Path!] });
      expect(result.ok).toBe(true);
      expect(result.views[0].bytes).toBeGreaterThan(0);
    }, 60_000);

    it("write_scad's syntax check also accepts libraryPaths for BOSL2-using models", async () => {
      const result = await runSyntaxCheck(scadPath, { libraryPaths: [bosl2Path!] });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    }, 60_000);

    // COUNTEREXAMPLE: omitting libraryPaths for a model that needs BOSL2. Empirically
    // verified against the pinned image: a missing `include <>` is a WARNING, not a
    // parse error -- OpenSCAD still exits 0 and renders an empty scene (same class of
    // behavior as the malicious-import containment test). The counterexample here is
    // that the WARNING is surfaced in the filtered diagnostic, not silently dropped.
    it("omitting libraryPaths for a BOSL2-dependent model degrades to an empty render with a surfaced WARNING, never a crash", async () => {
      const result = await renderViews({ scadPath, outDir, views: ["iso"] });
      expect(result.ok).toBe(true); // renders successfully -- just an empty scene
      expect(result.views[0].stderr ?? "").toMatch(/can't find include file/i);
    }, 60_000);
  }
);
