// @scadforge/scad-core — low-level mesh export: produces the requested
// export format PLUS a parallel binary-STL for `validate_mesh` (Spike 4's
// merged proposal: "openscad -o out.3mf -o out.stl ... runs ONE render and
// emits both files").
//
// EMPIRICAL CORRECTION to that proposal, verified against the pinned image
// (docker.io/openscad/openscad@sha256:0af06...): `--export-format=<X>`
// overrides the format of EVERY `-o` target in the invocation, not just the
// ambiguous one. `openscad -o out.3mf -o out.stl --export-format=binstl
// model.scad` does NOT produce a valid 3MF — it silently writes the SAME
// binary-STL bytes into `out.3mf` too (verified byte-for-byte identical with
// `out.stl`; `unzip`/`file` both reject the resulting "3mf" as not a zip).
// STL's own binary/ASCII ambiguity has no per-file `-O export-stl/...`
// setting either (checked `--help-export`; only `export-pdf`/`export-3mf`/
// `export-svg` sections exist in this build).
//
// So the true zero-corruption zero-cost path only exists when the requested
// format IS stl: one invocation, `--export-format=binstl`, one `-o` target,
// serving both roles. For `3mf`/`off`, this runs TWO invocations instead of
// one (documented cost deviation from the literal "-o out.3mf -o out.stl"
// AC wording — flagged on Issue #14): pass 1 exports the requested format
// with no `--export-format` override (unambiguous for 3mf/off); pass 2
// exports a dedicated binary STL for validation.
//
// SPDX-License-Identifier: Apache-2.0

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BACKEND, DEFAULT_COLORSCHEME, DEFAULT_RENDER_TIMEOUT_MS, OPENSCAD_EXPORT_FORMAT_FLAG } from "../types.js";
import type { ExportFormat } from "../types.js";
import { ScadForgeError } from "../errors.js";
import { runOpenscad } from "./docker.js";

/** See render.ts for the full rationale; same empirical finding applies here. */
const RENDER_FLAG = "--render=true";

function renderFlags(): string[] {
  return [`--backend=${DEFAULT_BACKEND}`, RENDER_FLAG, `--colorscheme=${DEFAULT_COLORSCHEME}`];
}

export interface MeshExportResult {
  /** Host path to the file in the REQUESTED format. */
  formatPath: string;
  /** Host path to the binary-STL validation input (== formatPath when format is already 'stl'). */
  stlPath: string;
  /** Wall-clock ms across every invocation this call made (1 for stl, 2 otherwise). */
  ms: number;
}

/**
 * Exports `model.scad` to `format`, plus a binary STL for `validate_mesh`,
 * into `dir` (a staged work directory — see `workdir.ts`). Never throws a
 * bare Error: any subprocess failure surfaces as a typed `ScadForgeError`
 * with `EXPORT_FAILED`.
 */
export async function exportMeshWithValidationStl(
  dir: string,
  inputName: string,
  format: ExportFormat,
  overrideArgs: readonly string[],
  timeoutMs: number = DEFAULT_RENDER_TIMEOUT_MS
): Promise<MeshExportResult> {
  const outFile = `out.${format}`;

  if (format === "stl") {
    const args = [
      "-o",
      `/work/${outFile}`,
      `--export-format=${OPENSCAD_EXPORT_FORMAT_FLAG.stl}`,
      ...renderFlags(),
      ...overrideArgs,
      `/work/${inputName}`
    ];
    const { ms } = await runAsExport(args, dir, timeoutMs);
    const hostPath = join(dir, outFile);
    await assertNonEmpty(hostPath);
    return { formatPath: hostPath, stlPath: hostPath, ms };
  }

  // Pass 1: the requested format. No --export-format override — 3mf/off are
  // each unambiguous by extension, and this invocation has only one -o target
  // so there is nothing else for a format override to corrupt anyway.
  const formatArgs = ["-o", `/work/${outFile}`, ...renderFlags(), ...overrideArgs, `/work/${inputName}`];
  const { ms: ms1 } = await runAsExport(formatArgs, dir, timeoutMs);
  const formatPath = join(dir, outFile);
  await assertNonEmpty(formatPath);

  // Pass 2: a dedicated binary STL for validate_mesh, in its own invocation
  // so `--export-format=binstl` has only one `-o` target to apply to.
  const stlFile = "validate.stl";
  const stlArgs = [
    "-o",
    `/work/${stlFile}`,
    `--export-format=${OPENSCAD_EXPORT_FORMAT_FLAG.stl}`,
    ...renderFlags(),
    ...overrideArgs,
    `/work/${inputName}`
  ];
  const { ms: ms2 } = await runAsExport(stlArgs, dir, timeoutMs);
  const stlPath = join(dir, stlFile);
  await assertNonEmpty(stlPath);

  return { formatPath, stlPath, ms: ms1 + ms2 };
}

async function runAsExport(args: string[], dir: string, timeoutMs: number) {
  try {
    return await runOpenscad(args, { cwd: dir, timeoutMs });
  } catch (err) {
    throw ScadForgeError.normalize(err, "EXPORT_FAILED", "mesh export failed");
  }
}

async function assertNonEmpty(path: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    throw new ScadForgeError("EXPORT_FAILED", `export produced no output file: ${path}`, { cause: err });
  }
  if (size <= 0) {
    throw new ScadForgeError("EXPORT_FAILED", `export produced an empty output file: ${path}`);
  }
}
