// SPDX-License-Identifier: Apache-2.0
//
// Shared runtime context + low-level project-store access used by BOTH
// concrete seam implementations (`scad-core-impl.ts` for the REST surface,
// `agent-scad-core.ts` for the agent's tool surface). Everything that reads or
// writes `.scadforge/` goes through here so the two never drift apart on
// where a file lives or how a failure is typed.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_AGENT_SDK_PROVIDER_ID, resolveMaxPasses } from "@scadforge/agent";
import { bosl2Path, mcadPath } from "@scadforge/libs";
import {
  PARAMS_ACTIVE_PRESET,
  PARAMS_FILE_FORMAT_VERSION,
  ScadForgeError,
  readProjectManifest,
  readSnapshotManifest,
  rootModelPath,
  rootParamsPath,
  runParamExport,
  snapshotDir,
  validateParamValues,
  withRecoveredProject
} from "@scadforge/scad-core";
import type { LockedProject, ParamRejection, ParamSchema, ParamValues, ParamsFile } from "@scadforge/scad-core";
import type { ProjectManifest, ProviderConfig, SnapshotId } from "@scadforge/protocol";
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

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Reads the project's current `model.scad` under the recovery boundary.
 * Returns `""` when it has not been written yet (ordinary — a brand-new
 * project's root files, or a pre-init state). Any OTHER read failure
 * (permissions, `EISDIR`, ...) is a genuine problem and is surfaced as
 * `INTERNAL_ERROR` rather than silently degrading to an empty model —
 * Issue #73: the pre-#73 code folded EVERY failure into `""`, so a real
 * (if unreadable) model could be silently treated as blank and then
 * overwritten by the next save.
 */
export async function readScad(dir: string): Promise<string> {
  return asRouteResult(() => withRecoveredProject(dir, (ctx) => readScadLocked(ctx)), "failed to read model.scad");
}

/** `ctx`-taking sibling of {@link readScad}, for a caller composing this read with other locked reads under one boundary entry. */
export async function readScadLocked(ctx: LockedProject): Promise<string> {
  try {
    return await readFile(rootModelPath(ctx.projectDir), "utf8");
  } catch (err) {
    if (isEnoent(err)) return "";
    throw toRouteError(err, "failed to read model.scad");
  }
}

/**
 * Reads the project's current parameter values out of the Customizer preset
 * file, under the recovery boundary. A MISSING `params.json` (a legacy
 * pre-S3 project, or a pre-init state) is ordinary and yields `{}`; a
 * `params.json` that EXISTS but cannot be parsed is corrupt and must never
 * be silently treated the same way (Issue #73) — the pre-#73 code folded
 * both into `{}`, which on the next write would have replaced real (if
 * corrupt) bytes with a fresh file built from nothing.
 */
export async function readParams(dir: string): Promise<ParamValues> {
  return asRouteResult(() => withRecoveredProject(dir, (ctx) => readParamsLocked(ctx)), "failed to read params.json");
}

/** `ctx`-taking sibling of {@link readParams}. */
export async function readParamsLocked(ctx: LockedProject): Promise<ParamValues> {
  let raw: string;
  try {
    raw = await readFile(rootParamsPath(ctx.projectDir), "utf8");
  } catch (err) {
    if (isEnoent(err)) return {};
    throw toRouteError(err, "failed to read params.json");
  }
  try {
    const parsed = JSON.parse(raw) as ParamsFile;
    return (parsed.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;
  } catch (err) {
    throw toRouteError(err, "params.json is corrupt");
  }
}

/**
 * Reads snapshot `id`'s OWN persisted `model.scad` — NEVER the project's
 * current root `model.scad` (Issue #45). Re-validating or re-rendering a
 * specific snapshot must describe THAT snapshot's own content, even when the
 * project's root state (and head) have since moved on to a newer snapshot.
 */
export async function readSnapshotScad(dir: string, id: SnapshotId): Promise<string> {
  const manifest = await asRouteResult(() => readSnapshotManifest(dir, id), `failed to read snapshot '${id}'`);
  return readFile(join(snapshotDir(dir, id), manifest.files.model_scad), "utf8");
}

/** Reads snapshot `id`'s OWN persisted parameter values — see {@link readSnapshotScad}. */
export async function readSnapshotParams(dir: string, id: SnapshotId): Promise<ParamValues> {
  const manifest = await asRouteResult(() => readSnapshotManifest(dir, id), `failed to read snapshot '${id}'`);
  const raw = await readFile(join(snapshotDir(dir, id), manifest.files.params_json), "utf8");
  const parsed = JSON.parse(raw) as ParamsFile;
  return (parsed.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;
}

/** A snapshot's own model + params, staged into a throwaway temp file for OpenSCAD to read. */
export interface StagedSnapshotModel {
  /** Absolute path to a temp copy of the snapshot's own `model.scad`. */
  scadPath: string;
  /** The snapshot's own persisted parameter values. */
  params: ParamValues;
  /** Removes the temp staging directory. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Stages snapshot `id`'s OWN `model.scad`/`params.json` into a fresh temp
 * file, so a caller running a (possibly slow) OpenSCAD invocation against it
 * is immune to a concurrent `write_scad`/`set_params` changing the project's
 * root files or even the snapshot's own directory mid-flight (Issue #45:
 * pinning the snapshot id is necessary but not sufficient without also
 * pinning the bytes actually handed to OpenSCAD).
 */
export async function stageSnapshotModel(dir: string, id: SnapshotId): Promise<StagedSnapshotModel> {
  const [content, params] = await Promise.all([readSnapshotScad(dir, id), readSnapshotParams(dir, id)]);
  const stageDir = await mkdtemp(join(tmpdir(), "scadforge-snapshot-stage-"));
  const scadPath = join(stageDir, "model.scad");
  await writeFile(scadPath, content, "utf8");
  return { scadPath, params, cleanup: () => rm(stageDir, { recursive: true, force: true }).catch(() => {}) };
}

/**
 * Writes the project's root `params.json` WITHOUT creating a snapshot — the
 * `snapshot: false` path of `PUT /api/projects/:id/params`. Uses the same
 * one-preset Customizer file shape the store writes, so a later snapshot reads
 * back exactly what was persisted here.
 *
 * Takes `ctx` (Issue #73): this is a root-state write, so it must run inside
 * an active recovery boundary — its only caller (`scad-core-impl.ts`'s
 * `updateParams`) already holds one via `mergeParamsAtomic`'s `persist`
 * callback.
 */
export async function writeRootParamsLocked(ctx: LockedProject, params: ParamValues): Promise<void> {
  const file: ParamsFile = {
    fileFormatVersion: PARAMS_FILE_FORMAT_VERSION,
    parameterSets: { [PARAMS_ACTIVE_PRESET]: params }
  };
  await writeFile(rootParamsPath(ctx.projectDir), JSON.stringify(file, null, 2), "utf8");
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

/** The result of validating a partial params update against the live Customizer schema. */
export interface ParamUpdatePlan {
  /** The subset of `values` that validated (declared, right type, in range). */
  accepted: ParamValues;
  /** Empty when every supplied value validated. Never applied. */
  rejected: ParamRejection[];
}

/**
 * THE single code path (Issue #32) that validates a caller-supplied partial
 * `values` bag against the project's live Customizer schema via
 * `validateParamValues` (`@scadforge/scad-core`). Both `routes/params.ts`
 * (through `scad-core-impl.ts`'s `updateParams`) and the agent's `set_params`
 * tool (through `agent-scad-core.ts`'s `setParams`) call this — neither
 * re-derives the validation rules itself, so a value the REST route accepts
 * and a value the agent accepts can never disagree.
 *
 * Deliberately does NOT read or merge onto the project's CURRENT
 * `params.json` (Issue #44): whether a value is accepted depends only on
 * `values` and the schema, never on `current`, so that read can wait until
 * immediately before the write, inside `@scadforge/scad-core`'s
 * `mergeParamsAtomic` — the params LOCK's cross-process mutex. Merging here
 * instead (the old code) computed `merged` from a `current` read that raced
 * every other concurrent writer's own read-merge-write of the SAME file: two
 * updates to disjoint keys could each merge onto a stale `current` and the
 * writer that persisted last would silently discard the other's change.
 *
 * Callers still decide what to DO with `rejected`: the REST route treats any
 * rejection as a hard `VALIDATION_FAILED` BEFORE ever touching `params.json`
 * (never a silent coerce); the agent's frozen `set_params` result shape has
 * no field for a per-value error, so it folds every rejection into
 * `unknown_params` and passes only `accepted` on to `mergeParamsAtomic` — see
 * each call site.
 */
export async function planParamUpdate(
  dir: string,
  runtime: ServerRuntime,
  values: ParamValues
): Promise<ParamUpdatePlan> {
  const schema = await readParamSchema(dir, runtime);
  return validateParamValues(schema, values);
}
