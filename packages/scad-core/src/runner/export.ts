// @scadforge/scad-core — `export`: mesh export gated by `validate_mesh`
// (CLAUDE.md hard rule 7 / Issue #14 AC "export refuses on failed gates").
//
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_RENDER_TIMEOUT_MS } from "../types.js";
import type { ExportRunRequest, ExportRunResult } from "../types.js";
import { ScadForgeError } from "../errors.js";
import { validateMesh } from "../validate/validate.js";
import { exportMeshWithValidationStl } from "./mesh-export.js";
import { writeOverrideParamsFile } from "./params-file.js";
import { stageWork } from "./workdir.js";

/**
 * `export` — exports `request.format`, validates the mesh first, and refuses
 * (typed `VALIDATION_FAILED`) on a red gate unless `allowValidationFailure`
 * is set. Never throws a bare Error: subprocess/filesystem failures surface
 * as `ExportRunResult.ok === false` with a typed `error_code`.
 */
export async function exportRun(
  request: ExportRunRequest,
  options?: { libraryPaths?: readonly string[] }
): Promise<ExportRunResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const start = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - start) / 1e6;

  const work = await stageWork(request.scadPath, { libraryPaths: options?.libraryPaths });
  try {
    const overrideArgs = await writeOverrideParamsFile(work.dir, request.params);

    let meshResult;
    try {
      meshResult = await exportMeshWithValidationStl(work.dir, work.modelName, request.format, overrideArgs, timeoutMs);
    } catch (err) {
      const typed = ScadForgeError.normalize(err, "EXPORT_FAILED", "export failed");
      return {
        ok: false,
        path: null,
        format: request.format,
        bytes: null,
        export_ms: elapsedMs(),
        validation: null,
        validation_overridden: false,
        error_code: typed.error_code,
        message: typed.message
      };
    }

    let validation;
    try {
      validation = await validateMesh({ meshPath: meshResult.stlPath });
    } catch (err) {
      const typed = ScadForgeError.normalize(err, "MESH_PARSE_FAILED", "export: validation failed");
      return {
        ok: false,
        path: null,
        format: request.format,
        bytes: null,
        export_ms: elapsedMs(),
        validation: null,
        validation_overridden: false,
        error_code: typed.error_code,
        message: typed.message
      };
    }

    const gate = validation.gate;
    const gateFailed = !gate.ok;
    const overridden = gateFailed && request.allowValidationFailure === true;

    if (gateFailed && !overridden) {
      return {
        ok: false,
        path: null,
        format: request.format,
        bytes: null,
        export_ms: elapsedMs(),
        validation: gate,
        validation_overridden: false,
        error_code: "VALIDATION_FAILED",
        message: `export refused: ${gate.failures.map((f) => f.message).join("; ") || "validation gate failed"}`
      };
    }

    try {
      await mkdir(request.outDir, { recursive: true });
      const destPath = join(request.outDir, `out.${request.format}`);
      await copyFile(meshResult.formatPath, destPath);
      const bytes = (await stat(destPath)).size;
      return {
        ok: true,
        path: destPath,
        format: request.format,
        bytes,
        export_ms: elapsedMs(),
        validation: gate,
        validation_overridden: overridden
      };
    } catch (err) {
      const typed = ScadForgeError.normalize(err, "EXPORT_FAILED", "failed to write export output");
      return {
        ok: false,
        path: null,
        format: request.format,
        bytes: null,
        export_ms: elapsedMs(),
        validation: gate,
        validation_overridden: overridden,
        error_code: typed.error_code,
        message: typed.message
      };
    }
  } finally {
    await work.cleanup();
  }
}
