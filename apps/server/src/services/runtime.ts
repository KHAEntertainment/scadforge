// SPDX-License-Identifier: Apache-2.0
//
// Shared runtime context + low-level project-store access used by BOTH
// concrete seam implementations (`scad-core-impl.ts` for the REST surface,
// `agent-scad-core.ts` for the agent's tool surface). Everything that reads or
// writes `.scadforge/` goes through here so the two never drift apart on
// where a file lives or how a failure is typed.

import { readFile, writeFile } from "node:fs/promises";
import { CLAUDE_AGENT_SDK_PROVIDER_ID, resolveMaxPasses } from "@scadforge/agent";
import { bosl2Path, mcadPath } from "@scadforge/libs";
import {
  PARAMS_ACTIVE_PRESET,
  PARAMS_FILE_FORMAT_VERSION,
  ScadForgeError,
  readProjectManifest,
  rootModelPath,
  rootParamsPath,
  runParamExport,
  validateParamValues
} from "@scadforge/scad-core";
import type { ParamRejection, ParamSchema, ParamValues, ParamsFile } from "@scadforge/scad-core";
import type { ProjectManifest, ProviderConfig } from "@scadforge/protocol";
import { RouteError } from "./errors.js";
import { projectDir, resolveProjectsRoot } from "./project-paths.js";

/** Env var naming the advisory model id handed to the provider. */
export const MODEL_ENV_VAR = "SCADFORGE_MODEL";

/** Everything the two seam implementations need to reach the filesystem and the renderer. */
export interface ServerRuntime {
  /** Absolute project root — one directory per project. */
  root: string;
  /**
   * Vendored library directories staged into every OpenSCAD work dir, so
   * `include <BOSL2/std.scad>` resolves (packages/libs, Issue #19).
   */
  libraryPaths: readonly string[];
  /** The `ProviderConfig` persisted into a new project's `project.json`. */
  provider: ProviderConfig;
  /** Absolute directory of one project. */
  dirFor(projectId: string): string;
}

/** Builds the runtime from the environment. */
export function createServerRuntime(env: NodeJS.ProcessEnv = process.env): ServerRuntime {
  const root = resolveProjectsRoot(env);
  const model = env[MODEL_ENV_VAR]?.trim();
  const provider: ProviderConfig = {
    provider: CLAUDE_AGENT_SDK_PROVIDER_ID,
    model: model && model.length > 0 ? model : null,
    max_passes: resolveMaxPasses(env)
  };
  return {
    root,
    libraryPaths: [bosl2Path(), mcadPath()],
    provider,
    dirFor: (projectId: string) => projectDir(root, projectId)
  };
}

// ── error mapping ────────────────────────────────────────────────────────────

/**
 * Maps a `ScadForgeError` onto the route layer's `RouteError`, preserving the
 * frozen error code so `toErrorResponse` picks the right HTTP status. Anything
 * else becomes `INTERNAL_ERROR` — a route must never see a raw stack trace
 * (PROJECT_CONTEXT.md "Error handling").
 */
export function toRouteError(err: unknown, fallbackMessage: string): RouteError {
  if (err instanceof RouteError) return err;
  if (ScadForgeError.is(err)) return new RouteError(err.error_code, err.message);
  const detail = err instanceof Error ? err.message : String(err);
  return new RouteError("INTERNAL_ERROR", `${fallbackMessage}: ${detail}`);
}

/** Runs `fn`, converting any rejection into a typed {@link RouteError}. */
export async function asRouteResult<T>(fn: () => Promise<T>, fallbackMessage: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toRouteError(err, fallbackMessage);
  }
}

// ── store reads ──────────────────────────────────────────────────────────────

/** Reads a project manifest, or throws `PROJECT_NOT_FOUND` as a `RouteError`. */
export async function readProject(dir: string): Promise<ProjectManifest> {
  return asRouteResult(() => readProjectManifest(dir), "failed to read project");
}

/** Reads the project's current `model.scad`. Returns `""` when it has not been written yet. */
export async function readScad(dir: string): Promise<string> {
  try {
    return await readFile(rootModelPath(dir), "utf8");
  } catch {
    return "";
  }
}

/** Reads the project's current parameter values out of the Customizer preset file. */
export async function readParams(dir: string): Promise<ParamValues> {
  try {
    const parsed = JSON.parse(await readFile(rootParamsPath(dir), "utf8")) as ParamsFile;
    return (parsed.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;
  } catch {
    return {};
  }
}

/**
 * Writes the project's root `params.json` WITHOUT creating a snapshot — the
 * `snapshot: false` path of `PUT /api/projects/:id/params`. Uses the same
 * one-preset Customizer file shape the store writes, so a later snapshot reads
 * back exactly what was persisted here.
 */
export async function writeRootParams(dir: string, params: ParamValues): Promise<void> {
  const file: ParamsFile = {
    fileFormatVersion: PARAMS_FILE_FORMAT_VERSION,
    parameterSets: { [PARAMS_ACTIVE_PRESET]: params }
  };
  await writeFile(rootParamsPath(dir), JSON.stringify(file, null, 2), "utf8");
}

/** An empty schema, used when the current model cannot be parsed for parameters yet. */
const EMPTY_PARAM_SCHEMA: ParamSchema = { title: "", parameters: [] };

/**
 * The live Customizer schema for the project at `dir`, or an empty schema
 * when the current `model.scad` does not parse (a brand-new project's
 * placeholder, or a broken intermediate state) — never a throw. Used ONLY to
 * validate a params UPDATE (see {@link planParamUpdate}); the REST `GET
 * .../params` route (`scad-core-impl.ts`'s `paramsResponse`) still surfaces a
 * genuine parse failure as `RENDER_FAILED`, since a caller asking to READ the
 * schema needs to know it isn't available.
 */
export async function readParamSchema(dir: string, runtime: ServerRuntime): Promise<ParamSchema> {
  try {
    return await runParamExport(rootModelPath(dir), { libraryPaths: runtime.libraryPaths });
  } catch {
    return EMPTY_PARAM_SCHEMA;
  }
}

/** The result of validating and merging a partial params update onto the project's current values. */
export interface ParamUpdatePlan {
  /** The full parameter bag after the update — `current` with every ACCEPTED value from `values` applied. */
  merged: ParamValues;
  /** Empty when every supplied value validated. Never merged into `merged`. */
  rejected: ParamRejection[];
}

/**
 * THE single code path (Issue #32) that turns a caller-supplied partial
 * `values` bag into the full merged params.json contents, validated against
 * the project's live Customizer schema via `validateParamValues`
 * (`@scadforge/scad-core`). Both `routes/params.ts` (through
 * `scad-core-impl.ts`'s `updateParams`) and the agent's `set_params` tool
 * (through `agent-scad-core.ts`'s `setParams`) call this — neither re-derives
 * the merge or the validation rules itself, so a value the REST route
 * accepts and a value the agent accepts can never disagree.
 *
 * Callers still decide what to DO with `rejected`: the REST route treats any
 * rejection as a hard `VALIDATION_FAILED` (never a silent coerce); the
 * agent's frozen `set_params` result shape has no field for a per-value
 * error, so it folds every rejection into `unknown_params` and applies only
 * `merged` (which already excludes them) — see each call site.
 */
export async function planParamUpdate(
  dir: string,
  runtime: ServerRuntime,
  values: ParamValues
): Promise<ParamUpdatePlan> {
  const [schema, current] = await Promise.all([readParamSchema(dir, runtime), readParams(dir)]);
  const { accepted, rejected } = validateParamValues(schema, values);
  return { merged: { ...current, ...accepted }, rejected };
}
