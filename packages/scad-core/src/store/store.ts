// @scadforge/scad-core — the filesystem `.scadforge/` project store: numbered
// snapshots, unified diff vs. parent, append-only revert. Implements the
// FROZEN manifest contract in `@scadforge/protocol`'s `snapshot.ts` (SDP §8).
//
// History is APPEND-ONLY (protocol/snapshot.ts header comment): a revert
// copies a snapshot's files forward and creates a NEW snapshot; it never
// rewrites or deletes an existing one. No database (PROJECT_CONTEXT.md
// "Do not introduce a database").
//
// ── CONCURRENCY POLICY (binding for #17's routes and the M4 MCP server) ─────
//
// `createSnapshot` MUST be safe when called concurrently against the SAME
// `.scadforge/` tree — not just from two Promises in one Node process, but
// from two SEPARATE OS processes (the GUI server and, from M4 onward, the
// stdio MCP server, both writing the same project directory). An in-process
// mutex/lock cannot provide that guarantee, so snapshot id allocation is
// NOT "read project.json's head, compute next id, write files" (that read
// -modify-write has a race: two callers can read the same head and both
// compute the same next id, and `mkdir(dir, {recursive:true})` does NOT
// throw on an existing directory, so the second writer's files silently land
// on top of the first's — the exact defect QA reported).
//
// Instead, the directory name IS the lock: `claimNextSnapshotId` calls
// `mkdir(historyDir/<id>)` NON-recursively (no `recursive: true`), which is
// atomic at the filesystem/OS level — POSIX guarantees exactly one caller
// (in-process or cross-process, same machine) gets ENOERR for a given path;
// every other concurrent caller gets `EEXIST` and must retry with a freshly
// re-read head. This makes the id sequence gapless-and-collision-free without
// any external lock manager, and it composes correctly with the trailing
// `project.json.head` write: a caller can only ever compute id N+1 after it
// has observed head=N on disk, which is only true once the writer that
// claimed N has fully committed `project.json` — so the final head writes
// are transitively ordered by the same directory-claim race, never racing
// each other out of order.
//
// If a caller cannot claim ANY id within `SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS`
// (pathological contention, or a filesystem that cannot honor exclusive
// mkdir), `createSnapshot` fails with the frozen `CONFLICT` error code
// (`@scadforge/protocol` `ERROR_CODES`) rather than ever silently overwriting
// another snapshot. `apps/server`'s routes should map `CONFLICT` to HTTP 409
// (already the frozen mapping in `HTTP_STATUS_BY_ERROR_CODE`); the MCP server
// should surface it as a normal tool failure envelope (`{ok:false,
// error_code:'CONFLICT', message}`) and let the caller retry the whole
// `write_scad`/`set_params` call.
//
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  PROJECT_LAYOUT,
  type ExportRecord,
  type ProjectManifest,
  type ProviderConfig,
  type RenderRef,
  type SnapshotId,
  type SnapshotManifest,
  type SnapshotOrigin,
  type ValidationSummary
} from "@scadforge/protocol";
import { OPENSCAD_IMAGE, OPENSCAD_VERSION } from "../types.js";
import type { ParamValues, ParamsFile, ValidationGateResult, ValidationReport } from "../types.js";
import { PARAMS_ACTIVE_PRESET, PARAMS_FILE_FORMAT_VERSION } from "../types.js";
import { ScadForgeError, withTypedError } from "../errors.js";
import {
  exportsDir,
  historyDir,
  metaDir,
  nextSnapshotId,
  projectFilePath,
  rootModelPath,
  rootParamsPath,
  snapshotDir
} from "./paths.js";
import { readDerivedEnrichment } from "./derived.js";
import { withParamsLock } from "./params-lock.js";

// ── ProjectManifest (project.json) ──────────────────────────────────────────

export interface InitProjectInput {
  id: string;
  name: string;
  provider: ProviderConfig;
  /** Initial `model.scad` contents. */
  content: string;
  /** Initial parameter values. Defaults to `{}`. */
  params?: ParamValues;
  /** Initial snapshot message. Defaults to `""`. */
  message?: string;
}

/**
 * Initializes a new project's `.scadforge/` structure and creates its first
 * ("initial") snapshot. `projectDir` must not already contain a `.scadforge/`
 * directory.
 */
export async function initProject(
  projectDir: string,
  input: InitProjectInput
): Promise<{ project: ProjectManifest; snapshot: SnapshotManifest }> {
  return withTypedError(
    async () => {
      await mkdir(metaDir(projectDir), { recursive: true });
      await mkdir(historyDir(projectDir), { recursive: true });
      await mkdir(exportsDir(projectDir), { recursive: true });

      const now = new Date().toISOString();
      let project: ProjectManifest = {
        schema_version: 1,
        id: input.id,
        name: input.name,
        created: now,
        updated: now,
        openscad_image: OPENSCAD_IMAGE,
        openscad_version: OPENSCAD_VERSION,
        provider: input.provider,
        head: null
      };
      await writeProjectManifest(projectDir, project);

      const snapshot = await createSnapshot(projectDir, {
        content: input.content,
        params: input.params ?? {},
        message: input.message ?? "",
        origin: "initial",
        pass: null
      });

      project = await readProjectManifest(projectDir);
      return { project, snapshot };
    },
    "INTERNAL_ERROR",
    "failed to initialize project"
  );
}

export async function readProjectManifest(projectDir: string): Promise<ProjectManifest> {
  return withTypedError(
    async () => {
      const raw = await readFile(projectFilePath(projectDir), "utf8").catch((err) => {
        throw new ScadForgeError("PROJECT_NOT_FOUND", `project not found at '${projectDir}'`, { cause: err });
      });
      return JSON.parse(raw) as ProjectManifest;
    },
    "PROJECT_NOT_FOUND",
    `failed to read project manifest at '${projectDir}'`
  );
}

async function writeProjectManifest(projectDir: string, manifest: ProjectManifest): Promise<void> {
  await writeFile(projectFilePath(projectDir), JSON.stringify(manifest, null, 2), "utf8");
}

// ── SnapshotManifest (history/NNNN/manifest.json) ───────────────────────────

export interface CreateSnapshotInput {
  /** Complete new contents of `model.scad`. */
  content: string;
  /** Full parameter values in effect for this snapshot. */
  params: ParamValues;
  /** One-line summary (CLAUDE.md hard rule 5: never a fenced `.scad` block). */
  message: string;
  origin: SnapshotOrigin;
  /** Which agent pass produced this snapshot; null when not agent-authored. */
  pass: number | null;
  /** The full validation report, if `validate_mesh` ran for this snapshot. */
  validation?: { report: ValidationReport; gate: ValidationGateResult } | null;
  /** Rendered views to copy into this snapshot's `views/` directory. */
  renders?: readonly { view: RenderRef["view"]; sourcePath: string; render_ms: number | null }[];
  /**
   * Builds the HTTP URL the UI fetches a render from. `apps/server` owns
   * routing; scad-core stays decoupled and defaults to a bare relative path
   * when the caller does not supply one.
   */
  buildRenderUrl?: (snapshotId: SnapshotId, view: RenderRef["view"], file: string) => string;
}

/** Max attempts to claim a snapshot id before failing with `CONFLICT` (see the concurrency policy above). */
export const SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS = 50;

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

/** A short, jittered delay so retries don't spin the event loop in a tight loop under contention. */
function backoffDelay(attempt: number): Promise<void> {
  const ms = Math.min(5 + attempt * 5, 100) + Math.floor(Math.random() * 10);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Atomically claims the next snapshot id for `projectDir` — see the
 * CONCURRENCY POLICY comment at the top of this file. Returns the claimed
 * `id` and the `parent` it was computed from, with the snapshot directory
 * already created (empty) and exclusively owned by this call.
 */
async function claimNextSnapshotId(projectDir: string): Promise<{ id: SnapshotId; parent: SnapshotId | null }> {
  for (let attempt = 0; attempt < SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS; attempt++) {
    const project = await readProjectManifestOrNull(projectDir);
    const parent = project?.head ?? null;
    const id = nextSnapshotId(parent);
    const dir = snapshotDir(projectDir, id);
    try {
      // NON-recursive, exclusive create: this is the lock. `{ recursive: true }`
      // would succeed silently even when `dir` already exists, which is the
      // defect this fix closes -- see the header comment.
      await mkdir(dir);
      return { id, parent };
    } catch (err) {
      if (isEexist(err)) {
        if (attempt < SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS - 1) await backoffDelay(attempt);
        continue; // another writer (this process or another) claimed `id` first; re-read head and retry
      }
      throw err;
    }
  }
  throw new ScadForgeError(
    "CONFLICT",
    `could not allocate a snapshot id in '${projectDir}' after ${SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS} attempts (high write contention)`
  );
}

/**
 * Creates the next numbered snapshot: writes `model.scad`/`params.json`/
 * `message.md`, a unified diff against the parent snapshot (null for the
 * first), copies any renders, persists the validation report verbatim (if
 * given), writes `manifest.json`, and updates the project's root
 * `model.scad`/`params.json` and `project.json.head`.
 *
 * Safe under concurrent callers, including from separate OS processes
 * sharing the same `.scadforge/` tree -- see the CONCURRENCY POLICY comment
 * at the top of this file. Fails with a typed `CONFLICT` error rather than
 * ever silently overwriting another snapshot.
 */
export async function createSnapshot(projectDir: string, input: CreateSnapshotInput): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const { id, parent } = await claimNextSnapshotId(projectDir);
      const dir = snapshotDir(projectDir, id);
      try {
        return await writeSnapshotFiles(projectDir, dir, id, parent, input);
      } catch (err) {
        // The id was claimed but the write didn't complete -- clean up the
        // partial directory so it never lingers as a corrupt/unlistable
        // snapshot (best-effort; the real error below is what's reported).
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    },
    "INTERNAL_ERROR",
    "failed to create snapshot"
  );
}

async function writeSnapshotFiles(
  projectDir: string,
  dir: string,
  id: SnapshotId,
  parent: SnapshotId | null,
  input: CreateSnapshotInput
): Promise<SnapshotManifest> {
  const project = await readProjectManifestOrNull(projectDir);
  const viewsDirPath = join(dir, PROJECT_LAYOUT.snapshot.viewsDir);
  await mkdir(viewsDirPath, { recursive: true });

  // model.scad
  await writeFile(join(dir, PROJECT_LAYOUT.snapshot.modelFile), input.content, "utf8");

  // params.json (Customizer preset format, matching the project root convention)
  const paramsFile: ParamsFile = {
    fileFormatVersion: PARAMS_FILE_FORMAT_VERSION,
    parameterSets: { [PARAMS_ACTIVE_PRESET]: input.params }
  };
  await writeFile(join(dir, PROJECT_LAYOUT.snapshot.paramsFile), JSON.stringify(paramsFile, null, 2), "utf8");

  // message.md
  await writeFile(join(dir, PROJECT_LAYOUT.snapshot.messageFile), input.message ?? "", "utf8");

  // diff.patch vs parent (null for the first snapshot)
  let diffPatchRel: string | null = null;
  if (parent !== null) {
    const parentContent = await readFile(
      join(snapshotDir(projectDir, parent), PROJECT_LAYOUT.snapshot.modelFile),
      "utf8"
    ).catch(() => "");
    const patch = createTwoFilesPatch(
      `${parent}/model.scad`,
      `${id}/model.scad`,
      parentContent,
      input.content
    );
    await writeFile(join(dir, PROJECT_LAYOUT.snapshot.diffFile), patch, "utf8");
    diffPatchRel = PROJECT_LAYOUT.snapshot.diffFile;
  }

  // validation.json (verbatim ValidationReport) + the manifest's lightweight summary
  let validationJsonRel: string | null = null;
  let validationSummary: ValidationSummary | null = null;
  if (input.validation) {
    await writeFile(
      join(dir, PROJECT_LAYOUT.snapshot.validationFile),
      JSON.stringify(input.validation.report, null, 2),
      "utf8"
    );
    validationJsonRel = PROJECT_LAYOUT.snapshot.validationFile;
    validationSummary = {
      badge: input.validation.gate.badge,
      manifold: input.validation.report.manifold,
      components: input.validation.report.components,
      volume_mm3: input.validation.report.volume_mm3,
      warning_count: input.validation.gate.warnings.length
    };
  }

  // renders
  const renders: RenderRef[] = [];
  for (const r of input.renders ?? []) {
    const file = `${PROJECT_LAYOUT.snapshot.viewsDir}/${r.view}.png`;
    const dest = join(dir, file);
    await copyFile(r.sourcePath, dest);
    const { size } = await stat(dest);
    // width/height are not re-derived here (the frozen camera contract
    // fixes them per DEFAULT_IMAGE_SIZE / the request's imgsize override);
    // callers that need exact per-file dimensions read them from the
    // RenderResult that produced r.sourcePath.
    renders.push({
      view: r.view,
      file,
      url: input.buildRenderUrl ? input.buildRenderUrl(id, r.view, file) : `/${file}`,
      width: 0,
      height: 0,
      bytes: size,
      render_ms: r.render_ms
    });
  }

  const manifest: SnapshotManifest = {
    id,
    parent,
    timestamp: new Date().toISOString(),
    message: input.message,
    origin: input.origin,
    pass: input.pass,
    files: {
      model_scad: PROJECT_LAYOUT.snapshot.modelFile,
      params_json: PROJECT_LAYOUT.snapshot.paramsFile,
      message_md: PROJECT_LAYOUT.snapshot.messageFile,
      validation_json: validationJsonRel,
      diff_patch: diffPatchRel
    },
    params: input.params,
    renders,
    validation: validationSummary,
    annotations: []
  };
  await writeFile(join(dir, PROJECT_LAYOUT.snapshot.manifestFile), JSON.stringify(manifest, null, 2), "utf8");

  // Update root model.scad / params.json to the current state.
  await writeFile(rootModelPath(projectDir), input.content, "utf8");
  await writeFile(rootParamsPath(projectDir), JSON.stringify(paramsFile, null, 2), "utf8");

  // Update project.json head.
  if (project) {
    project.head = id;
    project.updated = manifest.timestamp;
    await writeProjectManifest(projectDir, project);
  }

  return manifest;
}

export async function readSnapshotManifest(projectDir: string, id: SnapshotId): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const raw = await readFile(join(snapshotDir(projectDir, id), PROJECT_LAYOUT.snapshot.manifestFile), "utf8").catch(
        (err) => {
          throw new ScadForgeError("SNAPSHOT_NOT_FOUND", `snapshot '${id}' not found in '${projectDir}'`, {
            cause: err
          });
        }
      );
      const manifest = JSON.parse(raw) as SnapshotManifest;

      // `history/<id>/manifest.json` itself is written exactly once, at
      // creation, and never opened for writing again (Issue #45). Renders and
      // validation attached AFTER creation live in the sibling `derived/<id>/`
      // tree (`attachments.ts`) and are merged in here, in memory, so every
      // caller still sees `.renders` / `.validation` populated -- the on-disk
      // history is what's actually immutable, not the shape callers see.
      const derived = await readDerivedEnrichment(projectDir, id);
      if (derived.renders !== null) manifest.renders = derived.renders;
      if (derived.validation !== null) {
        manifest.validation = derived.validation;
        manifest.files = { ...manifest.files, validation_json: PROJECT_LAYOUT.snapshot.validationFile };
      }
      return manifest;
    },
    "SNAPSHOT_NOT_FOUND",
    `failed to read snapshot '${id}'`
  );
}

/** Lists every snapshot manifest, oldest first. */
export async function listSnapshots(projectDir: string): Promise<SnapshotManifest[]> {
  return withTypedError(
    async () => {
      const dir = historyDir(projectDir);
      let entries: string[];
      try {
        entries = (await readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch (err) {
        throw new ScadForgeError("PROJECT_NOT_FOUND", `project history not found at '${projectDir}'`, { cause: err });
      }
      const manifests: SnapshotManifest[] = [];
      for (const id of entries) {
        manifests.push(await readSnapshotManifest(projectDir, id));
      }
      return manifests;
    },
    "PROJECT_NOT_FOUND",
    `failed to list snapshots in '${projectDir}'`
  );
}

/**
 * Reverts to `targetId`: copies its `model.scad`/`params.json` forward as a
 * BRAND NEW snapshot (origin `'revert'`), parented on the CURRENT head — never
 * rewrites or removes `targetId` or any snapshot in between (append-only,
 * protocol/snapshot.ts header comment).
 *
 * A revert REPLACES root `params.json` wholesale with `targetId`'s own full
 * bag (never a merge onto "current" — that's what makes it a revert), so it
 * cannot go through `mergeParamsAtomic` (whose whole point is merging new
 * values ONTO current). It still needs the SAME params lock (Issue #44): a
 * revert's `createSnapshot` call also writes root `params.json`/`model.scad`/
 * `project.json`, and without the lock it could interleave with a concurrent
 * `set_params`/params-update's own read-merge-write of the same files.
 */
export async function revertToSnapshot(projectDir: string, targetId: SnapshotId): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const target = await readSnapshotManifest(projectDir, targetId);
      const modelContent = await readFile(
        join(snapshotDir(projectDir, targetId), target.files.model_scad),
        "utf8"
      );
      const paramsRaw = await readFile(join(snapshotDir(projectDir, targetId), target.files.params_json), "utf8");
      const paramsFile = JSON.parse(paramsRaw) as ParamsFile;
      const params = (paramsFile.parameterSets[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;

      return withParamsLock(projectDir, () =>
        createSnapshot(projectDir, {
          content: modelContent,
          params,
          message: `Revert to ${targetId}`,
          origin: "revert",
          pass: null
        })
      );
    },
    "SNAPSHOT_NOT_FOUND",
    `failed to revert to snapshot '${targetId}'`
  );
}

// ── exports/ ledger (append-only list of ExportRecord written alongside files) ──

/** Appends one export record. `.scadforge/exports/index.json` is a plain array; not part of the frozen contract's own file list, but a reasonable v1 ledger for a directory that otherwise only holds files. */
export async function recordExport(projectDir: string, record: ExportRecord): Promise<void> {
  await withTypedError(
    async () => {
      const indexPath = join(exportsDir(projectDir), "index.json");
      let records: ExportRecord[] = [];
      try {
        records = JSON.parse(await readFile(indexPath, "utf8"));
      } catch {
        records = [];
      }
      records.push(record);
      await writeFile(indexPath, JSON.stringify(records, null, 2), "utf8");
    },
    "INTERNAL_ERROR",
    "failed to record export"
  );
}

// ── params.json read-merge-write (Issue #44) ────────────────────────────────

async function readRootParamsOrEmpty(projectDir: string): Promise<ParamValues> {
  try {
    const parsed = JSON.parse(await readFile(rootParamsPath(projectDir), "utf8")) as ParamsFile;
    return (parsed.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;
  } catch {
    return {};
  }
}

/**
 * THE single choke point for every writer that needs to merge new values onto
 * the CURRENT root `params.json` — a standalone params-only update
 * (`snapshot:false`), a `set_params`-driven snapshot, or a plain `write_scad`
 * carrying params forward unchanged (`accepted: {}`). Acquires the params
 * lock (`params-lock.ts`), reads the CURRENT persisted values, computes
 * `merged = {...current, ...accepted}`, and calls `persist(merged)` — all
 * while still holding the lock, so `persist`'s own writes (whether
 * `createSnapshot`, which also touches root `params.json`/`model.scad`/
 * `project.json`, or a bare params-only write) can never race a concurrent
 * caller's read-merge-write of the SAME file (Issue #44: two updates to
 * DISJOINT keys must both survive, never a last-write-wins lost update).
 *
 * `persist` must not itself call `mergeParamsAtomic`/acquire the params lock
 * (the lock is not reentrant) — pass it the pre-fetched Customizer schema
 * validation result (`accepted`/`rejected`) computed BEFORE calling this, so
 * the only work done while holding the lock is filesystem I/O (keeps lock
 * hold time short — rapid successive writes, e.g. a slider drag, must not
 * degrade per Issue #44's AC).
 */
export async function mergeParamsAtomic<T>(
  projectDir: string,
  accepted: ParamValues,
  persist: (merged: ParamValues) => Promise<T>
): Promise<T> {
  return withTypedError(
    () =>
      withParamsLock(projectDir, async () => {
        const current = await readRootParamsOrEmpty(projectDir);
        const merged = { ...current, ...accepted };
        return persist(merged);
      }),
    "INTERNAL_ERROR",
    "failed to update params"
  );
}

async function readProjectManifestOrNull(projectDir: string): Promise<ProjectManifest | null> {
  try {
    return await readProjectManifest(projectDir);
  } catch {
    return null;
  }
}
