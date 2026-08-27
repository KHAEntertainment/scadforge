// @scadforge/scad-core — writes a per-render `params.json` (Customizer preset
// file) for parameter overrides that must NOT be persisted to the project's
// real `params.json` (SDP §8; RenderRequest/ExportRunRequest `params` field).
//
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParamValues, ParamsFile } from "../types.js";
import { PARAMS_ACTIVE_PRESET, PARAMS_FILE_FORMAT_VERSION } from "../types.js";

/** The file name written into the per-render work directory for `-p <file> -P current`. */
export const RENDER_OVERRIDE_PARAMS_FILE = "__render_params.json";

/**
 * Writes `params` as a one-preset Customizer preset file into `workDir`.
 * Returns the CLI args to append (`-p <file> -P current`), or `[]` when there
 * are no overrides to write.
 */
export async function writeOverrideParamsFile(workDir: string, params: ParamValues | undefined): Promise<string[]> {
  if (!params || Object.keys(params).length === 0) return [];
  const file: ParamsFile = {
    fileFormatVersion: PARAMS_FILE_FORMAT_VERSION,
    parameterSets: { [PARAMS_ACTIVE_PRESET]: params }
  };
  await writeFile(join(workDir, RENDER_OVERRIDE_PARAMS_FILE), JSON.stringify(file, null, 2), "utf8");
  return ["-p", `/work/${RENDER_OVERRIDE_PARAMS_FILE}`, "-P", PARAMS_ACTIVE_PRESET];
}
