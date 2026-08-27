// @scadforge/scad-core — `validate_mesh` over a `.scad` SOURCE file.
//
// GLUE (Issue #20). `validate/validate.ts` validates an already-exported
// binary STL; `runner/export.ts` exports-and-gates but also WRITES the
// requested format. The `validate_mesh` tool sits between the two: it must
// take the current `model.scad` (plus per-call parameter overrides), produce
// the binary STL Spike 4's contract requires, validate it, and throw the
// intermediate away — writing nothing into the project.
//
// Before this existed, every caller (apps/server's agent adapter, and from M4
// packages/mcp-server) would have had to re-derive the stage → override-params
// → mesh-export → weld → gate sequence itself, which is exactly the kind of
// pipeline duplication that drifts. It lives here so the one implementation is
// shared, and so `ValidationResult.export_ms` — which `validateMesh` alone
// cannot know, since it never ran the export — is finally populated.
//
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_RENDER_TIMEOUT_MS } from "../types.js";
import type { ParamValues, ValidationGateOptions, ValidationResult } from "../types.js";
import { validateMesh } from "../validate/validate.js";
import { exportMeshWithValidationStl } from "./mesh-export.js";
import { writeOverrideParamsFile } from "./params-file.js";
import { stageWork } from "./workdir.js";

/** Options for {@link validateModel}. */
export interface ValidateModelOptions {
  /** Parameter overrides for this validation only; never persisted. */
  params?: ParamValues;
  /** Gate configuration (`allowMultiPart`, `minVolumeMm3`). */
  gate?: ValidationGateOptions;
  /** Defaults to {@link DEFAULT_RENDER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Library directories staged alongside the model (BOSL2/MCAD). */
  libraryPaths?: readonly string[];
}

/**
 * Renders `scadPath` to a throwaway binary STL and validates it with
 * manifold-3d, returning the frozen {@link ValidationResult} with `export_ms`
 * filled in.
 *
 * Rejects only with a typed `ScadForgeError` (`EXPORT_FAILED` from the mesh
 * export, `MESH_PARSE_FAILED` from the validator) — never a bare `Error`.
 */
export async function validateModel(scadPath: string, options: ValidateModelOptions = {}): Promise<ValidationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const work = await stageWork(scadPath, { libraryPaths: options.libraryPaths });
  try {
    const overrideArgs = await writeOverrideParamsFile(work.dir, options.params);
    // `format: "stl"` is the single-invocation path (mesh-export.ts): the
    // requested format IS the validation input, so no second render runs.
    const mesh = await exportMeshWithValidationStl(work.dir, work.modelName, "stl", overrideArgs, timeoutMs);
    const result = await validateMesh({ meshPath: mesh.stlPath, options: options.gate });
    return { ...result, export_ms: mesh.ms };
  } finally {
    await work.cleanup();
  }
}
