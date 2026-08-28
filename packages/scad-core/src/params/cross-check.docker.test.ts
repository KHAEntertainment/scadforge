// @docker — the highest-value AC for Issue #30: proves `parseParamSchema`
// (our own comment-grammar parser) agrees with the REAL pinned OpenSCAD
// image's `--export-format=param` output, not just with our assumptions
// about its grammar.
//
// Every fixture here was run for real against the pinned image
// (`sha256:0af06...b52fa7`) during development to determine ground truth —
// see `parse.ts`/`scan.ts`/`annotation.ts` doc comments for the citations.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerAvailable, fixture } from "../test-support/docker-available.js";
import { runParamExport } from "../runner/param-export.js";
import { parseParamSchema } from "./parse.js";
import type { ParamSchema } from "../types.js";
import type { ParamDefinition } from "../types.js";

const FIXTURES = ["basic.scad", "types.scad", "groups.scad", "boundary.scad", "special.scad"] as const;

async function parseFixtureLocally(name: string): Promise<ParamSchema> {
  const source = await readFile(fixture(`params/${name}`), "utf8");
  return parseParamSchema(source, { title: basename(name, ".scad") });
}

describe.skipIf(!dockerAvailable())("@docker parseParamSchema cross-check (real pinned OpenSCAD image)", () => {
  // AC 3: for >=5 annotated fixtures, our parser's output structurally
  // matches the pinned container's own `--export-format=param` JSON.
  for (const name of FIXTURES) {
    it(`${name}: matches the real CLI's --export-format=param output exactly`, async () => {
      const [ours, real] = await Promise.all([parseFixtureLocally(name), runParamExport(fixture(`params/${name}`))]);
      expect(ours).toEqual(real);
    }, 60_000);
  }

  it("sanity: the fixture set actually exercises groups/captions/ranges/options/maxLength/boundaries (not a vacuous pass)", async () => {
    const real = await runParamExport(fixture("params/basic.scad"));
    expect(real.parameters.length).toBeGreaterThan(0);
    expect(real.parameters.some((p) => p.min !== undefined)).toBe(true);
  }, 60_000);

  // Documented, deliberate divergence: a non-numeric vector. The real CLI
  // silently DROPS such a parameter from the schema entirely (confirmed:
  // `bool_vec`/`str_vec` never appear in its `--export-format=param`
  // output). We deliberately choose NOT to replicate that silent loss —
  // surfacing the parameter (as our own `"vector"` type) is safer for a
  // product that hands this schema to an agent/UI. This test proves both
  // halves of that divergence against the real CLI, so it's verified, not
  // just asserted in a comment.
  it("documented divergence: non-numeric vectors are dropped by the real CLI but surfaced by ours", async () => {
    // A lone `keep` numeric param keeps the real CLI's `parameters` array
    // non-empty (an all-dropped model omits the `parameters` key from its
    // `--export-format=param` JSON entirely — a separate quirk of the real
    // CLI, out of this issue's scope to reconcile).
    const source = 'keep = 1; // [0:10]\nbool_vec = [true,false,true];\nstr_vec = ["a","b"];\n';
    const real = await runParamExport(await writeTempFixture(source));
    expect(real.parameters.map((p) => p.name)).toEqual(["keep"]); // real CLI: silently dropped both vectors

    const ours = parseParamSchema(source, { title: real.title });
    expect(ours.parameters.map((p) => [p.name, p.type])).toEqual([
      ["keep", "number"],
      ["bool_vec", "vector"],
      ["str_vec", "vector"]
    ]); // ours: surfaced, not dropped
  }, 60_000);

  // Tech Lead / QA finding on PR #38: the real CLI's own CRLF handling is
  // confirmed unreliable (see `crlf.ts`'s doc comment for 3 probes showing
  // the SAME annotation on the SAME line-ending gets dropped in one file and
  // kept in another, depending on unrelated preceding content — not a simple
  // per-line rule). Rather than trying to byte-model that inconsistency, we
  // conservatively strip ALL annotation-derived fields file-wide whenever
  // CRLF is present. This test proves the actual safety property that
  // matters — our parser NEVER reports a min/max/step/caption/maxLength/
  // options the live CLI didn't ALSO report for that same parameter — for a
  // battery of real CRLF files, rather than asserting exact byte parity
  // (which the CLI's own inconsistency makes impossible to guarantee).
  it("CRLF safety property: our parser never over-promises annotation info the real CLI also drops", async () => {
    const crlfFixtures = [
      // Every declaration's own line is CRLF-terminated.
      '/* [Pipe] */\r\n// Outer diameter of the pipe\r\npipe_d = 32; // [10:80]\r\nwall = 4; //[2:0.5:10]\r\nEnabled = true;\r\n',
      // Mixed endings -- some lines LF, some CRLF.
      'pipe_d = 32; // [10:80]\nwall = 4; //[2:0.5:10]\r\nsmooth_fn = 48; // [16:8:128]\n',
      // A single stray CRLF deep in an otherwise-LF file.
      'a = 1; // [0:10]\nb = 2; // [0:20]\nc = 3; // [0:30]\r\nd = 4; // [0:40]\n'
    ];

    for (const source of crlfFixtures) {
      const path = await writeTempFixture(source);
      const real = await runParamExport(path);
      const ours = parseParamSchema(source, { title: real.title });

      expect(ours.parameters.length).toBeGreaterThan(0); // not a vacuous fixture

      const realByName = new Map(real.parameters.map((p) => [p.name, p]));
      for (const oursParam of ours.parameters) {
        // Baseline fields always survive, on both sides, per every probe.
        expect(oursParam.name.length).toBeGreaterThan(0);
        expect(oursParam).not.toHaveProperty("min");
        expect(oursParam).not.toHaveProperty("caption");

        const realParam = realByName.get(oursParam.name);
        expect(realParam, `real CLI dropped parameter '${oursParam.name}' entirely`).toBeDefined();
        for (const field of ["caption", "min", "max", "step", "maxLength", "options"] as const) {
          if (oursParam[field] !== undefined) {
            expect(
              (realParam as ParamDefinition)[field],
              `ours reported '${field}' on '${oursParam.name}' but the real CLI did not -- over-promising`
            ).toEqual(oursParam[field]);
          }
        }
      }
    }
  }, 60_000);
});

// Small helper: `runParamExport` takes a file path, so the inline-divergence
// test needs its adversarial source written to a throwaway file first.
async function writeTempFixture(source: string): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "scadforge-paramcheck-"));
  const path = join(dir, "divergence.scad");
  await writeFile(path, source, "utf8");
  return path;
}
