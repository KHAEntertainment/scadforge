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

import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
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
  /**
   * Absolute path to KEEP the binary STL at (ScadForge Issue #41).
   *
   * This function already renders a binary STL — it is the input manifold-3d
   * validates — and until now threw it away with the work directory, which is
   * why no `.stl` existed anywhere in a project tree and the 3D viewer was
   * permanently blank. Handing a destination in reuses that render instead of
   * paying for a second one.
   *
   * Persisting is BEST EFFORT: a copy that fails never fails the validation
   * the caller actually asked for. The frozen `ValidationResult` has no field
   * to report the destination in, and does not need one — the path is the
   * caller's own input, and its existence on disk is the whole signal.
   */
  persistMeshTo?: string;
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
    if (options.persistMeshTo) {
      await persistMesh(mesh.stlPath, options.persistMeshTo);
    }
    const result = await validateMesh({ meshPath: mesh.stlPath, options: options.gate });
    return { ...result, export_ms: mesh.ms };
  } finally {
    await work.cleanup();
  }
}

/**
 * Copies the just-rendered validation STL to `dest`.
 *
 * Written via a sibling `.tmp` file and then renamed, so a reader (the mesh
 * route, streaming bytes to the viewer) never observes a half-written STL —
 * `rename` within one directory is atomic. Best effort by contract: any
 * failure resolves quietly, leaving whatever mesh was already there intact.
 */
async function persistMesh(sourcePath: string, dest: string): Promise<void> {
  const tmp = `${dest}.tmp`;
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(sourcePath, tmp);
    await rename(tmp, dest);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
