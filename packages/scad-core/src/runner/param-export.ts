// @scadforge/scad-core — `--export-format=param`: acquires the Customizer
// `ParamSchema` straight from the pinned OpenSCAD CLI (SDP §7 preferred path).
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_RENDER_TIMEOUT_MS, OPENSCAD_PARAM_EXPORT_FORMAT } from "../types.js";
import type { ParamSchema } from "../types.js";
import { ScadForgeError, withTypedError } from "../errors.js";
import { runOpenscad } from "./docker.js";
import { stageWork } from "./workdir.js";

const PARAM_EXPORT_FILE = "__params.param.json";

/**
 * Runs `openscad --export-format=param -o <file> model.scad` and parses the
 * result into the frozen {@link ParamSchema}. Round-trips: any consumer that
 * later writes `params.json` from this schema and re-runs this function gets
 * an equivalent schema back (Issue #14 AC "param round-trip").
 */
export async function runParamExport(
  scadPath: string,
  options?: { timeoutMs?: number; libraryPaths?: readonly string[] }
): Promise<ParamSchema> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const work = await stageWork(scadPath, { libraryPaths: options?.libraryPaths });
  try {
    const args = [
      "-o",
      `/work/${PARAM_EXPORT_FILE}`,
      `--export-format=${OPENSCAD_PARAM_EXPORT_FORMAT}`,
      `/work/${work.modelName}`
    ];
    await withTypedError(() => runOpenscad(args, { cwd: work.dir, timeoutMs }), "RENDER_FAILED", "param export failed");

    const raw = await withTypedError(
      () => readFile(join(work.dir, PARAM_EXPORT_FILE), "utf8"),
      "RENDER_FAILED",
      "param export produced no output file"
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ScadForgeError("RENDER_FAILED", `param export produced invalid JSON: ${(err as Error).message}`, {
        cause: err
      });
    }

    return validateParamSchemaShape(parsed);
  } finally {
    await work.cleanup();
  }
}

/** Minimal structural validation — enough to catch a malformed/truncated export without a full schema library. */
function validateParamSchemaShape(value: unknown): ParamSchema {
  if (typeof value !== "object" || value === null || !("parameters" in value) || !Array.isArray((value as { parameters?: unknown }).parameters)) {
    throw new ScadForgeError("RENDER_FAILED", "param export JSON did not match the expected {title, parameters[]} shape");
  }
  const withTitle = value as { title?: unknown; parameters: unknown[] };
  return {
    title: typeof withTitle.title === "string" ? withTitle.title : "",
    parameters: withTitle.parameters as ParamSchema["parameters"]
  };
}
