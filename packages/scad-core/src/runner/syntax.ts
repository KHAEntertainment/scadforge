// @scadforge/scad-core — `write_scad`'s syntax check: a cheap, parse-only
// OpenSCAD invocation (CSG-tree export; never a full geometry render).
//
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_RENDER_TIMEOUT_MS } from "../types.js";
import type { SyntaxCheckResult } from "../types.js";
import { ScadForgeError } from "../errors.js";
import { runOpenscad } from "./docker.js";
import { stageWork } from "./workdir.js";

const SYNTAX_CHECK_OUTPUT_FILE = "__syntax_check.csg";

function extractDiagnostics(stderr: string, prefix: "ERROR" | "WARNING"): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${prefix}:`));
}

/**
 * Runs a cheap, parse-only check of `.scad` source: exports the CSG tree
 * (`--export-format=csg`), which requires OpenSCAD to fully parse the file
 * but not evaluate a full CGAL/Manifold render. `ok` is true only when
 * OpenSCAD exits zero AND emits no `ERROR:` lines.
 */
export async function runSyntaxCheck(
  scadPath: string,
  options?: { timeoutMs?: number; libraryPaths?: readonly string[] }
): Promise<SyntaxCheckResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const work = await stageWork(scadPath, { libraryPaths: options?.libraryPaths });
  try {
    const args = ["-o", `/work/${SYNTAX_CHECK_OUTPUT_FILE}`, "--export-format=csg", `/work/${work.modelName}`];
    try {
      const { ms, stderr } = await runOpenscad(args, { cwd: work.dir, timeoutMs });
      const errors = extractDiagnostics(stderr, "ERROR");
      const warnings = extractDiagnostics(stderr, "WARNING");
      return { ok: errors.length === 0, errors, warnings, ms };
    } catch (err) {
      const typed = ScadForgeError.normalize(err, "SYNTAX_ERROR", "write_scad syntax check failed");
      return { ok: false, errors: [typed.message], warnings: [], ms: 0 };
    }
  } finally {
    await work.cleanup();
  }
}
