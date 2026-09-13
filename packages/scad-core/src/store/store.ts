// @scadforge/scad-core — the filesystem `.scadforge/` project store: numbered
// snapshots, unified diff vs. parent, append-only revert. Implements the
// FROZEN manifest contract in `@scadforge/protocol`'s `snapshot.ts` (SDP §8).
//
// History is APPEND-ONLY (protocol/snapshot.ts header comment): a revert
// copies a snapshot's files forward and creates a NEW snapshot; it never
// rewrites or deletes an existing one. No database (PROJECT_CONTEXT.md
// "Do not introduce a database").
//
// ── THE RECOVERY BOUNDARY (Issue #73 / S3-B ticket B2) ──────────────────────
//
// Every function here that touches root `model.scad`/`params.json`/
// `project.json` now goes through `recovered.ts`'s `withRecoveredProject` —
// the single mutable-project access boundary. Each EXPORTED function below
// is a thin delegator: it opens the boundary once and calls its own
// `*Locked(ctx, ...)` sibling, which does the actual work and NEVER reopens
// the boundary itself. A caller that already holds a `ctx` (this package's
// own `revertToSnapshotLocked`, or `apps/server`'s composed operations) must
// call the `*Locked` variant directly — calling the exported delegator from
// inside an active boundary throws immediately (`recovered.ts`'s
// non-reentrancy guard), rather than deadlocking on the underlying lock.
//
// ── CONCURRENCY POLICY (binding for #17's routes and the M4 MCP server) ─────
//
// `createSnapshot` MUST be safe when called concurrently against the SAME
// `.scadforge/` tree — not just from two Promises in one Node process, but
// from two SEPARATE OS processes (the GUI server and, from M4 onward, the
// stdio MCP server, both writing the same project directory). Snapshot id
// allocation is NOT "read project.json's head, compute next id, write files"
// (that read-modify-write has a race: two callers can read the same head and
// both compute the same next id, and `mkdir(dir, {recursive:true})` does NOT
// throw on an existing directory, so the second writer's files silently land
// on top of the first's — the exact defect QA reported).
//
// Instead, the directory name IS the lock: `claimNextSnapshotId` calls
// `mkdir(historyDir/<id>)` NON-recursively (no `recursive: true`), which is
// atomic at the filesystem/OS level — POSIX guarantees exactly one caller
// (in-process or cross-process, same machine) gets ENOERR for a given path;
// every other concurrent caller gets `EEXIST` and must retry with a freshly
// re-read head. Since Issue #73, `createSnapshotLocked` ALSO runs under the
// project's params lock (the recovery boundary), so this id-claim race can
// only ever be with a writer that failed to acquire that lock in the first
// place — a defense-in-depth belt, not the primary mechanism, which stays
// the atomic directory claim below (a lock alone is not sufficient across a
// process that dies mid-write without releasing it; the directory claim's
// own orphan-reclaim, `isReclaimableOrphanClaim`, is what makes id
// allocation itself gapless-and-collision-free even then).
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

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { normalizeLineEndings } from "../lf.js";
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
import { readDerivedEnrichmentLocked, writeDerivedValidationLocked } from "./derived.js";
import { withFileLock } from "./file-lock.js";
import { type LockedProject, type ReadResult, withRecoveredProject } from "./recovered.js";
import {
  attachRendersToSnapshotLocked,
  resolveSnapshotMeshPath,
  resolveSnapshotRenderPath,
  resolveSnapshotValidationPath,
  snapshotMeshPath
} from "./attachments.js";

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
 *
 * `.scadforge/` (and the lock directory the recovery boundary needs under
 * it) does not exist yet for a brand-new project, so this creates the meta
 * tree FIRST and only THEN enters the boundary — the boundary itself must
 * never special-case "the lock's parent doesn't exist yet", since for every
 * OTHER writer that is a genuine `PROJECT_NOT_FOUND` (see `recovered.ts`).
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
      return withRecoveredProject(projectDir, (ctx) => initProjectLocked(ctx, input));
    },
    "INTERNAL_ERROR",
    "failed to initialize project"
  );
}

async function initProjectLocked(
  ctx: LockedProject,
  input: InitProjectInput
): Promise<{ project: ProjectManifest; snapshot: SnapshotManifest }> {
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
  await writeProjectManifest(ctx.projectDir, project);

  const snapshot = await createSnapshotLocked(ctx, {
    content: input.content,
    params: input.params ?? {},
    message: input.message ?? "",
    origin: "initial",
    pass: null
  });

  project = await readProjectManifestLocked(ctx);
  return { project, snapshot };
}

/**
 * Reads `projectDir`'s `project.json`. Distinguishes the project not
 * existing (`PROJECT_NOT_FOUND`) from `project.json` existing but being
 * unparseable (`INTERNAL_ERROR`, Issue #73 AC) — the pre-#73 code folded
 * both into `PROJECT_NOT_FOUND`, which misreported real corruption as a
 * project that was simply never created.
 */
export async function readProjectManifest(projectDir: string): Promise<ProjectManifest> {
  return withRecoveredProject(projectDir, (ctx) => readProjectManifestLocked(ctx));
}

/** `ctx`-taking sibling of {@link readProjectManifest}, for a caller composing this read with other locked reads under one boundary entry (`apps/server`'s `projectResponse`/`coherentSourceState`/agent `readProject`). */
export async function readProjectManifestLocked(ctx: LockedProject): Promise<ProjectManifest> {
  let raw: string;
  try {
    raw = await readFile(projectFilePath(ctx.projectDir), "utf8");
  } catch (err) {
    throw new ScadForgeError("PROJECT_NOT_FOUND", `project not found at '${ctx.projectDir}'`, { cause: err });
  }
  try {
    return JSON.parse(raw) as ProjectManifest;
  } catch (err) {
    throw new ScadForgeError(
      "INTERNAL_ERROR",
      `project manifest at '${projectFilePath(ctx.projectDir)}' is corrupt`,
      { cause: err }
    );
  }
}

/**
 * Same read as {@link readProjectManifestLocked}, but typed so a caller that
 * treats "no project.json yet" as an ordinary, expected state (id-claiming
 * during `createSnapshot`, which may run before `project.json` exists on a
 * still-being-initialized project) can tell that apart from corruption,
 * which must never be silently treated the same way (Issue #73 AC6: a
 * corrupt `project.json` must fail `createSnapshot` before any write, not
 * be read as "no manifest yet").
 */
async function readProjectManifestOrNullLocked(ctx: LockedProject): Promise<ReadResult<ProjectManifest>> {
  let raw: string;
  try {
    raw = await readFile(projectFilePath(ctx.projectDir), "utf8");
  } catch {
    return { kind: "absent" };
  }
  try {
    return { kind: "present", value: JSON.parse(raw) as ProjectManifest };
  } catch (err) {
    return {
      kind: "corrupt",
      error: new ScadForgeError(
        "INTERNAL_ERROR",
        `project manifest at '${projectFilePath(ctx.projectDir)}' is corrupt`,
        { cause: err }
      )
    };
  }
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

/** Minimum age (ms) of a manifest-less snapshot directory before it is treated as an orphaned claim and reclaimed (issue #28). */
export const ORPHANED_CLAIM_MIN_AGE_MS = 60_000;

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

/** A short, jittered delay so retries don't spin the event loop in a tight loop under contention. */
function backoffDelay(attempt: number): Promise<void> {
  const ms = Math.min(5 + attempt * 5, 100) + Math.floor(Math.random() * 10);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * A directory that blocks an id claim is reclaimable only when it is an
 * ORPHANED CLAIM (issue #28): it carries no `manifest.json` (a committed
 * snapshot always has one -- it is written before `project.json.head`
 * advances, so its presence means the id is genuinely taken and must never
 * be touched) AND it has been quiet longer than `ORPHANED_CLAIM_MIN_AGE_MS`
 * (a live writer keeps the directory's mtime fresh while it creates files,
 * so a directory this old with no manifest can only be the debris of a
 * process that died between the exclusive mkdir and either the manifest
 * write or the cleanup path).
 */
async function isReclaimableOrphanClaim(dir: string): Promise<boolean> {
  const hasManifest = await stat(join(dir, PROJECT_LAYOUT.snapshot.manifestFile)).then(
    () => true,
    () => false
  );
  if (hasManifest) return false;
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat) return false; // vanished (a concurrent reclaimer freed it) -- just retry the mkdir
  return Date.now() - dirStat.mtimeMs >= ORPHANED_CLAIM_MIN_AGE_MS;
}

/**
 * Atomically claims the next snapshot id for `ctx.projectDir` — see the
 * CONCURRENCY POLICY comment at the top of this file. Returns the claimed
 * `id` and the `parent` it was computed from, with the snapshot directory
 * already created (empty) and exclusively owned by this call.
 *
 * A corrupt `project.json` fails THIS call, before any directory is ever
 * claimed (Issue #73 AC6) — legacy absence (no `project.json` yet, e.g.
 * mid-`initProject`) still computes `parent: null` exactly as before.
 */
async function claimNextSnapshotId(ctx: LockedProject): Promise<{ id: SnapshotId; parent: SnapshotId | null }> {
  for (let attempt = 0; attempt < SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS; attempt++) {
    const projectRead = await readProjectManifestOrNullLocked(ctx);
    if (projectRead.kind === "corrupt") throw projectRead.error;
    const parent = projectRead.kind === "present" ? projectRead.value.head : null;
    const id = nextSnapshotId(parent);
    const dir = snapshotDir(ctx.projectDir, id);
    try {
      // NON-recursive, exclusive create: this is the lock. `{ recursive: true }`
      // would succeed silently even when `dir` already exists, which is the
      // defect this fix closes -- see the header comment.
      await mkdir(dir);
      return { id, parent };
    } catch (err) {
      if (isEexist(err)) {
        if (await isReclaimableOrphanClaim(dir)) {
          // Issue #28: a previous process died between this exclusive mkdir
          // and either the manifest write or the cleanup path. Its
          // manifest-less debris wedges every future claim of this id --
          // the head never advanced, so each retry recomputes the same id
          // forever. Reclaim the debris and let the loop retry the exclusive
          // mkdir on the freed name; a concurrent reclaimer that wins the
          // race simply costs us another EEXIST round-trip.
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        if (attempt < SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS - 1) await backoffDelay(attempt);
        continue; // another writer (this process or another) claimed `id` first; re-read head and retry
      }
      throw err;
    }
  }
  throw new ScadForgeError(
    "CONFLICT",
    `could not allocate a snapshot id in '${ctx.projectDir}' after ${SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS} attempts (high write contention)`
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
  return withRecoveredProject(projectDir, (ctx) => createSnapshotLocked(ctx, input));
}

/** `ctx`-taking sibling of {@link createSnapshot} for a caller that already holds the boundary (`initProjectLocked`, `revertToSnapshotLocked`, `mergeParamsAtomic`'s `persist`, `apps/server`'s composed writers). Never reacquires the lock. */
export async function createSnapshotLocked(ctx: LockedProject, input: CreateSnapshotInput): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const { id, parent } = await claimNextSnapshotId(ctx);
      const dir = snapshotDir(ctx.projectDir, id);
      try {
        return await writeSnapshotFiles(ctx, dir, id, parent, input);
      } catch (err) {
        // The id was claimed but the write didn't complete -- clean up the
        // partial directory so it never lingers as a corrupt/unlistable
        // snapshot (best-effort; the real error below is what's reported).
        // This is also what satisfies AC6 if `project.json` corruption is
        // instead observed by writeSnapshotFiles's OWN later re-read of it
        // (updating head) rather than by claimNextSnapshotId's earlier one.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    },
    "INTERNAL_ERROR",
    "failed to create snapshot"
  );
}

async function writeSnapshotFiles(
  ctx: LockedProject,
  dir: string,
  id: SnapshotId,
  parent: SnapshotId | null,
  input: CreateSnapshotInput
): Promise<SnapshotManifest> {
  const projectRead = await readProjectManifestOrNullLocked(ctx);
  if (projectRead.kind === "corrupt") throw projectRead.error;
  const project = projectRead.kind === "present" ? projectRead.value : null;
  const viewsDirPath = join(dir, PROJECT_LAYOUT.snapshot.viewsDir);
  await mkdir(viewsDirPath, { recursive: true });

  // Normalize to LF-only (Issue #40) BEFORE writing, so the snapshot, root
  // `model.scad`, and the `diff.patch` against the parent all carry identical
  // bytes -- the CLI runner and `--export-format=param` parser then never see
  // a CRLF file the store did not intend.
  const content = normalizeLineEndings(input.content);

  // model.scad
  await writeFile(join(dir, PROJECT_LAYOUT.snapshot.modelFile), content, "utf8");

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
      join(snapshotDir(ctx.projectDir, parent), PROJECT_LAYOUT.snapshot.modelFile),
      "utf8"
    ).catch(() => "");
    const patch = createTwoFilesPatch(
      `${parent}/model.scad`,
      `${id}/model.scad`,
      parentContent,
      content
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
  await writeFile(rootModelPath(ctx.projectDir), content, "utf8");
  await writeFile(rootParamsPath(ctx.projectDir), JSON.stringify(paramsFile, null, 2), "utf8");

  // Update project.json head.
  if (project) {
    project.head = id;
    project.updated = manifest.timestamp;
    await writeProjectManifest(ctx.projectDir, project);
  }

  return manifest;
}

/**
 * Reads a snapshot's `manifest.json`, merging in any post-creation
 * enrichment (`derived.ts`). Distinguishes the snapshot not existing
 * (`SNAPSHOT_NOT_FOUND`) from `manifest.json` existing but being unparseable
 * (`INTERNAL_ERROR`, Issue #73 AC7) — the pre-#73 code folded corruption
 * into "not found", which is how the head snapshot's route
 * (`apps/server`'s `headSnapshot`) used to render real corruption as
 * "this project simply has no head yet".
 */
export async function readSnapshotManifest(projectDir: string, id: SnapshotId): Promise<SnapshotManifest> {
  return withRecoveredProject(projectDir, (ctx) => readSnapshotManifestLocked(ctx, id));
}

/** `ctx`-taking sibling of {@link readSnapshotManifest}. */
export async function readSnapshotManifestLocked(ctx: LockedProject, id: SnapshotId): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const manifestPath = join(snapshotDir(ctx.projectDir, id), PROJECT_LAYOUT.snapshot.manifestFile);
      let raw: string;
      try {
        raw = await readFile(manifestPath, "utf8");
      } catch (err) {
        throw new ScadForgeError("SNAPSHOT_NOT_FOUND", `snapshot '${id}' not found in '${ctx.projectDir}'`, {
          cause: err
        });
      }
      let manifest: SnapshotManifest;
      try {
        manifest = JSON.parse(raw) as SnapshotManifest;
      } catch (err) {
        throw new ScadForgeError("INTERNAL_ERROR", `snapshot '${id}' manifest at '${manifestPath}' is corrupt`, {
          cause: err
        });
      }

      // `history/<id>/manifest.json` itself is written exactly once, at
      // creation, and never opened for writing again (Issue #45). Renders and
      // validation attached AFTER creation live in the sibling `derived/<id>/`
      // tree (`attachments.ts`) and are merged in here, in memory, so every
      // caller still sees `.renders` / `.validation` populated -- the on-disk
      // history is what's actually immutable, not the shape callers see.
      //
      // LEGACY PROJECTS (predate this fix): the pre-fix code wrote renders/
      // validation directly into `manifest.json` itself, so `manifest` (just
      // parsed above) ALREADY carries them for such a snapshot. There is no
      // `derived/<id>/` tree for it, so `readDerivedEnrichmentLocked` returns
      // both fields `null` and the `if` guards below leave the legacy data
      // in `manifest.renders`/`manifest.validation` completely untouched --
      // manifest-level reads need no fallback. Only the PHYSICAL BYTES (the
      // PNG/`validation.json` a render/validation entry points at) can still
      // be missing from `derived/`, which is what `resolveSnapshotRenderPath`
      // / `resolveSnapshotValidationPath` (`attachments.ts`) fall back to
      // `history/<id>/` for.
      const derived = await readDerivedEnrichmentLocked(ctx, id);
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

/**
 * Lists every snapshot manifest, oldest first. An unreadable snapshot
 * directory fails the WHOLE listing, naming the offending id — never a
 * silent skip (Issue #73 AC8): a caller that got a shorter-than-expected
 * list before had no way to know a snapshot was missing versus simply
 * created later.
 */
export async function listSnapshots(projectDir: string): Promise<SnapshotManifest[]> {
  return withRecoveredProject(projectDir, (ctx) => listSnapshotsLocked(ctx));
}

/** `ctx`-taking sibling of {@link listSnapshots}. */
export async function listSnapshotsLocked(ctx: LockedProject): Promise<SnapshotManifest[]> {
  return withTypedError(
    async () => {
      const dir = historyDir(ctx.projectDir);
      let entries: string[];
      try {
        entries = (await readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch (err) {
        throw new ScadForgeError("PROJECT_NOT_FOUND", `project history not found at '${ctx.projectDir}'`, { cause: err });
      }
      const manifests: SnapshotManifest[] = [];
      for (const id of entries) {
        try {
          manifests.push(await readSnapshotManifestLocked(ctx, id));
        } catch (err) {
          throw new ScadForgeError(
            "INTERNAL_ERROR",
            `failed to list snapshots in '${ctx.projectDir}': snapshot '${id}' is unreadable (${
              err instanceof Error ? err.message : String(err)
            })`,
            { cause: err }
          );
        }
      }
      return manifests;
    },
    "PROJECT_NOT_FOUND",
    `failed to list snapshots in '${ctx.projectDir}'`
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
 * values ONTO current). It still needs the SAME recovery boundary (Issue
 * #44/#73): a revert's `createSnapshotLocked` call also writes root
 * `params.json`/`model.scad`/`project.json`, and without the shared lock it
 * could interleave with a concurrent `set_params`/params-update's own
 * read-merge-write of the same files.
 */
export interface RevertToSnapshotOptions {
  /** Rebuilds render URLs for the newly-created snapshot id. */
  buildRenderUrl?: CreateSnapshotInput["buildRenderUrl"];
}

export async function revertToSnapshot(
  projectDir: string,
  targetId: SnapshotId,
  options: RevertToSnapshotOptions = {}
): Promise<SnapshotManifest> {
  return withRecoveredProject(projectDir, (ctx) => revertToSnapshotLocked(ctx, targetId, options));
}

/** `ctx`-taking sibling of {@link revertToSnapshot}. */
export async function revertToSnapshotLocked(
  ctx: LockedProject,
  targetId: SnapshotId,
  options: RevertToSnapshotOptions = {}
): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const target = await readSnapshotManifestLocked(ctx, targetId);
      const modelContent = await readFile(
        join(snapshotDir(ctx.projectDir, targetId), target.files.model_scad),
        "utf8"
      );
      const paramsRaw = await readFile(join(snapshotDir(ctx.projectDir, targetId), target.files.params_json), "utf8");
      const paramsFile = JSON.parse(paramsRaw) as ParamsFile;
      const params = (paramsFile.parameterSets[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;

      // Resolve read locations before creating the new snapshot. Each
      // resolver checks the post-creation `derived/` tree first and then
      // the legacy `history/` location, so both project shapes restore.
      // Missing artifacts are ordinary: a snapshot may never have been
      // rendered or validated, and a stale legacy pointer must not make the
      // model/params revert fail. Immutable file resolution, unlike the
      // manifest read above, deliberately stays outside the boundary's
      // concern (see `attachments.ts`'s resolvers) -- it is read-only
      // against already-committed, write-once bytes.
      const renderSources = (
        await Promise.all(
          target.renders.map(async (render) => {
            const sourcePath = await resolveSnapshotRenderPath(ctx.projectDir, targetId, render.view);
            return sourcePath ? { render, sourcePath } : null;
          })
        )
      ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const validationSource = target.validation
        ? await resolveSnapshotValidationPath(ctx.projectDir, targetId)
        : null;
      const meshSource = await resolveSnapshotMeshPath(ctx.projectDir, targetId);

      const reverted = await createSnapshotLocked(ctx, {
        content: modelContent,
        params,
        message: `Revert to ${targetId}`,
        origin: "revert",
        pass: null
      });

      if (renderSources.length > 0) {
        await attachRendersToSnapshotLocked(
          ctx,
          reverted.id,
          renderSources.map(({ render, sourcePath }) => ({
            view: render.view,
            sourcePath,
            render_ms: render.render_ms,
            width: render.width,
            height: render.height
          })),
          { buildRenderUrl: options.buildRenderUrl }
        );
      }

      if (validationSource && target.validation) {
        const report = JSON.parse(await readFile(validationSource, "utf8")) as ValidationReport;
        await writeDerivedValidationLocked(ctx, reverted.id, report, target.validation);
      }

      if (meshSource) {
        const destination = snapshotMeshPath(ctx.projectDir, reverted.id);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(meshSource, destination);
      }

      // Re-read through the normal merge surface so the caller immediately
      // receives the restored render refs and validation summary. The raw
      // `history/<new-id>/manifest.json` remains the immutable creation
      // record; all copied enrichment lives under `derived/<new-id>/`.
      return readSnapshotManifestLocked(ctx, reverted.id);
    },
    "SNAPSHOT_NOT_FOUND",
    `failed to revert to snapshot '${targetId}'`
  );
}

// ── exports/ ledger (append-only list of ExportRecord written alongside files) ──

/**
 * Appends one export record. Uses its OWN `exports.lock` (Issue #48),
 * deliberately a SEPARATE lock resource from the project's params lock/
 * recovery boundary above: the exports ledger is not part of the project's
 * mutable root/history state the boundary protects, so this may run either
 * inside or outside an active `withRecoveredProject` call without tripping
 * its non-reentrancy guard (which only watches nested `withRecoveredProject`
 * calls, not this module's own `withFileLock`).
 */
export async function recordExport(projectDir: string, record: ExportRecord): Promise<void> {
  await withTypedError(
    async () => {
      const exportsDirectory = exportsDir(projectDir);
      const indexPath = join(exportsDirectory, "index.json");
      // The ledger is read-merge-written, so every append must hold the
      // exports lock (Issue #48): without it, two concurrent exports both
      // read the SAME current array, each push only its own record, and
      // whichever `writeFile` lands last wins wholesale -- silently losing
      // the other's entry. Cross-process safe (see file-lock.ts).
      await withFileLock(join(metaDir(projectDir), "exports.lock"), "exports", async () => {
        let records: ExportRecord[];
        try {
          records = JSON.parse(await readFile(indexPath, "utf8"));
          if (!Array.isArray(records)) throw new Error("ledger is valid JSON but not an array");
        } catch (err) {
          if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
            records = []; // no ledger yet -- the normal first-export case
          } else {
            // A corrupt or partially-written ledger is DETECTED, never
            // silently parsed as empty (that would overwrite it with a
            // one-record array, both losing every prior entry and
            // destroying the evidence). The bytes on disk are left
            // untouched for inspection/repair.
            throw new ScadForgeError(
              "INTERNAL_ERROR",
              `exports ledger '${indexPath}' is corrupt (${err instanceof Error ? err.message : String(err)}) -- refusing to append; inspect or repair the file manually`
            );
          }
        }
        records.push(record);
        // Atomic replace: a reader never sees a half-written ledger, and a
        // crash mid-write leaves the previous complete version in place.
        await mkdir(exportsDirectory, { recursive: true });
        const tmpPath = `${indexPath}.tmp`;
        await writeFile(tmpPath, JSON.stringify(records, null, 2), "utf8");
        await rename(tmpPath, indexPath);
      });
    },
    "INTERNAL_ERROR",
    "failed to record export"
  );
}

// ── params.json read-merge-write (Issue #44) ────────────────────────────────

/**
 * Reads root `params.json`. Legacy absence (no root `params.json` yet, e.g.
 * a pre-S3 project) is ordinary and yields `{}`; a `params.json` that exists
 * but cannot be parsed is CORRUPT and must never be silently treated as `{}`
 * (Issue #73 AC5) — the pre-#73 code folded both into `{}`, silently
 * discarding a real (if corrupt) params file on the next write.
 */
async function readRootParamsOrEmptyLocked(ctx: LockedProject): Promise<ReadResult<ParamValues>> {
  let raw: string;
  try {
    raw = await readFile(rootParamsPath(ctx.projectDir), "utf8");
  } catch {
    return { kind: "absent" };
  }
  try {
    const parsed = JSON.parse(raw) as ParamsFile;
    return { kind: "present", value: (parsed.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues };
  } catch (err) {
    return {
      kind: "corrupt",
      error: new ScadForgeError("INTERNAL_ERROR", `root params.json at '${rootParamsPath(ctx.projectDir)}' is corrupt`, {
        cause: err
      })
    };
  }
}

/**
 * THE single choke point for every writer that needs to merge new values onto
 * the CURRENT root `params.json` — a standalone params-only update
 * (`snapshot:false`), a `set_params`-driven snapshot, or a plain `write_scad`
 * carrying params forward unchanged (`accepted: {}`). Acquires the recovery
 * boundary, reads the CURRENT persisted values (failing `INTERNAL_ERROR` on
 * corruption rather than silently merging onto `{}` -- Issue #73 AC5), and
 * calls `persist(merged, ctx)` — all while still holding the lock, so
 * `persist`'s own writes can never race a concurrent caller's read-merge
 * -write of the SAME file (Issue #44: two updates to DISJOINT keys must both
 * survive, never a last-write-wins lost update).
 *
 * `persist` receives the SAME `ctx` this call is already holding and must
 * use it (e.g. `createSnapshotLocked(ctx, ...)`) rather than any exported
 * delegator — calling one of those would re-enter the boundary and throw
 * immediately (Issue #73's non-reentrancy guard, `recovered.ts`). Keep
 * `persist` to filesystem I/O only — anything slow (an OpenSCAD subprocess
 * call to fetch the live Customizer schema, say) should run BEFORE calling
 * this, so rapid successive writes (a slider-drag pattern) never degrade
 * into a long lock-held chain, and a crashed holder cannot wedge every other
 * writer for long either.
 */
export async function mergeParamsAtomic<T>(
  projectDir: string,
  accepted: ParamValues,
  persist: (merged: ParamValues, ctx: LockedProject) => Promise<T>
): Promise<T> {
  return withRecoveredProject(projectDir, async (ctx) => {
    const currentRead = await readRootParamsOrEmptyLocked(ctx);
    if (currentRead.kind === "corrupt") throw currentRead.error;
    const current = currentRead.kind === "present" ? currentRead.value : {};
    const merged = { ...current, ...accepted };
    return persist(merged, ctx);
  });
}
