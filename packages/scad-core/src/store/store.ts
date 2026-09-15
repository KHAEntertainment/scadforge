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

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  PROJECT_LAYOUT,
  type EditorReceipt,
  type EditorSidecar,
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
  rootParamsPath,
  sidecarPath,
  snapshotDir
} from "./paths.js";
import { readDerivedEnrichmentLocked, writeDerivedValidationLocked } from "./derived.js";
import { withFileLock } from "./file-lock.js";
import { type LockedProject, type ReadResult, withRecoveredProject } from "./recovered.js";
import {
  captureSidecarForSnapshotLocked,
  readSidecarLocked,
  readSnapshotSidecarLocked,
  serializeCanonicalSidecar
} from "../editor/sidecar.js";
import {
  attachRendersToSnapshotLocked,
  resolveSnapshotMeshPath,
  resolveSnapshotRenderPath,
  resolveSnapshotValidationPath,
  snapshotMeshPath
} from "./attachments.js";
import {
  decideLocked,
  publishLocked,
  reconcileTransactionLocked,
  stageTransactionLocked,
  type TransactionClaimLink,
  type TransactionIntent
} from "./transaction.js";
import type { AcceptedOperationRecord } from "./claims.js";
import { computeSourceRevision } from "./revision.js";
import { editorRevision as computeEditorRevision } from "../editor/canonical.js";

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

/**
 * Additive extension for a snapshot-producing commit that must publish a
 * durable operation claim + receipt in the SAME transaction as the snapshot
 * (S3-B ticket B6, Issue #98). Only ever present for an editor command.
 */
export interface CreateSnapshotEditorExtension {
  /** Links this transaction to the caller's already-reserved durable operation claim. */
  claim: TransactionClaimLink;
  /**
   * The claim's undo/redo before/after record. Omitted (not just falsy —
   * genuinely absent) for an undo/redo commit itself, which deliberately
   * does not become traversable (`editor/commands.ts`'s
   * `applyEditorTraversal`).
   */
  accepted?: AcceptedOperationRecord;
  /**
   * Builds the `EditorReceipt` to stage and publish alongside everything
   * else. Called synchronously, AFTER the snapshot id is claimed and the
   * resulting source revision / sidecar digest / editor revision are known,
   * BEFORE staging begins — so a caller that only needs the receipt (rather
   * than restructuring this function's return type) captures it via a
   * closure variable set inside this callback.
   */
  buildReceipt: (facts: { snapshotId: SnapshotId; sourceRevision: string; sidecarDigest: string; editorRevision: string }) => EditorReceipt;
}

/**
 * Additive options for a snapshot-producing commit (S3-B ticket B6, Issue
 * #98 — Tech Lead ruling, generalized after the F1 fault-matrix finding
 * (#103) that the sidecar override must stand alone, independent of any
 * operation-claim/receipt concern). Omitted entirely, `createSnapshotLocked`
 * behaves byte-for-byte as before: the default
 * `captureSidecarForSnapshotLocked` "read current root" capture, no claim
 * link, no receipt.
 *
 * Every field here lands in the SAME `commit.json` as the snapshot/root
 * files this call already stages — there is no second write, and no caller
 * (editor commands, revert, the legacy-empty first-mutation path) ever calls
 * `writeSidecarBytesLocked` as a SEPARATE transaction before this one.
 * Store.ts keeps sole ownership of the id claim, the empty-claimed-directory
 * cleanup on a pre-decide failure, and the single stage → decide → publish;
 * a caller never reaches into any of that itself.
 */
export interface CreateSnapshotOptions {
  /**
   * The COMPLETE new sidecar this snapshot should carry, staged as BOTH the
   * root `.scadforge/editor.json` AND this snapshot's own captured copy +
   * manifest descriptor — instead of `captureSidecarForSnapshotLocked`'s
   * "whatever the current root sidecar already is" default. Canonicalized
   * here via B3's `serializeCanonicalSidecar`; a caller must never hand-roll
   * canonical bytes itself. Omitted for an ordinary (non-sidecar-changing)
   * snapshot: `revert` and editor `put-feature`/`remove-feature` supply
   * this; editor `set-value` does not (its sidecar is unchanged).
   */
  sidecar?: EditorSidecar;
  /**
   * Flips `project.editor_store_version` to 1 in the SAME `project.json`
   * write this call already stages for `head`/`updated`. The caller decides
   * this (it already read the current sidecar/project state to get here) —
   * store.ts never re-derives it. Ignored when omitted/false; never
   * downgrades an already-modern project.
   */
  markerFlip?: boolean;
  /** Present only for a durable-operation-claim commit (an editor command). */
  editor?: CreateSnapshotEditorExtension;
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
 * be touched).
 *
 * EMPTY orphans reclaim IMMEDIATELY, no age wait (Issue #98 F2 — B8's fault
 * matrix, PR #103): since B2/B4, `claimNextSnapshotId` is the ONLY thing
 * that ever creates this directory directly, and always empty — B4's own
 * publish step populates it exclusively via an atomic rename from staging,
 * never an in-place write. Both this call and the `recover()` that already
 * ran earlier in THIS boundary entry hold the SAME exclusive params lock, so
 * nothing can be concurrently "still writing into" a directory this call can
 * see right now; an empty, manifest-less directory found here can only be
 * the debris of an earlier lock-holder that crashed before publish ever
 * reached this id. The OLD unconditional age gate wedged every writer for up
 * to `ORPHANED_CLAIM_MIN_AGE_MS` after exactly this crash.
 *
 * A NON-EMPTY, manifest-less orphan should no longer be PRODUCIBLE under
 * B4's model at all: `publishHistoryDirIdempotent` populates `history/<id>/`
 * exclusively via one atomic rename of the fully-staged directory, never an
 * in-place/partial write — so there is no code path left that can leave
 * behind a manifest-less directory with SOME content in it. This branch is
 * kept anyway, conservatively, for two reasons: (1) defense in depth against
 * a future writer that reintroduces a partial in-place write, and (2) a
 * directory tree inherited from BEFORE this migration (pre-B4-shaped
 * debris) could still carry exactly this shape. For that case the original
 * age-gated wait (issue #28) still applies — a live writer keeps the
 * directory's mtime fresh while it creates files, so quiet-long-enough with
 * no manifest can only be dead-process debris.
 */
async function isReclaimableOrphanClaim(dir: string): Promise<boolean> {
  const hasManifest = await stat(join(dir, PROJECT_LAYOUT.snapshot.manifestFile)).then(
    () => true,
    () => false
  );
  if (hasManifest) return false;
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return false; // vanished (a concurrent reclaimer freed it) -- just retry the mkdir
  if (entries.length === 0) return true;
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat) return false; // vanished mid-check -- just retry the mkdir
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

/**
 * `ctx`-taking sibling of {@link createSnapshot} for a caller that already
 * holds the boundary (`initProjectLocked`, `revertToSnapshotLocked`,
 * `mergeParamsAtomic`'s `persist`, `apps/server`'s composed writers). Never
 * reacquires the lock.
 *
 * S3-B ticket B4: publishes through the staged roll-forward transaction
 * mechanism (`stageTransactionLocked` → `decideLocked` → `publishLocked`,
 * `transaction.ts`) instead of a bare write sequence. Nothing authoritative
 * changes before `decideLocked`'s `commit.json` is durable. If anything
 * throws before that point, {@link reconcileTransactionLocked} is called
 * synchronously (not merely left for the next boundary entry) so the
 * claimed-but-unstaged/unpublished `history/<id>` directory never lingers as
 * a visible partial entry — this is what keeps `claimNextSnapshotId`'s
 * "the id claim stays the id reservation; an abandoned reservation leaves a
 * gap, never a partial entry" true even for an ordinary in-process failure,
 * not only a real crash.
 */
export async function createSnapshotLocked(
  ctx: LockedProject,
  input: CreateSnapshotInput,
  opts?: CreateSnapshotOptions
): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const { id, parent } = await claimNextSnapshotId(ctx);
      const transactionId = randomUUID();
      try {
        const intent = await buildSnapshotIntent(ctx, transactionId, id, parent, input, opts);
        const staged = await stageTransactionLocked(ctx, intent);
        const decided = await decideLocked(ctx, staged);
        await publishLocked(ctx, decided);
        // The manifest we just staged & published, verbatim -- matches the
        // pre-B4 behavior of returning the in-memory object rather than
        // re-reading it (no DERIVED enrichment exists yet for a snapshot
        // this call just created).
        return intent.snapshot!.manifest;
      } catch (err) {
        // Best-effort, synchronous self-heal: if `commit.json` was never
        // written, this aborts the transaction (quarantining any staged
        // bytes) and removes the claimed `history/<id>` directory -- but
        // ONLY if it is still empty, and NEVER if a commit.json exists (see
        // `transaction.ts`'s `reconcileTransactionLocked`). If publication
        // was already durable and merely partial, this instead FINISHES it
        // idempotently. Swallowed here because the ORIGINAL error below is
        // what the caller needs to see; a real crash gets the same
        // reconciliation from the next boundary entry's `recover()` either way.
        await reconcileTransactionLocked(ctx, transactionId, id).catch(() => {});
        throw err;
      }
    },
    "INTERNAL_ERROR",
    "failed to create snapshot"
  );
}

/**
 * Builds the COMPLETE `TransactionIntent` for a new snapshot: every root and
 * history byte this operation will publish, computed from reads only —
 * nothing here touches the real `history/<id>` directory or any root file.
 * Throws (before any staging begins) exactly where `writeSnapshotFiles` used
 * to throw: a corrupt `project.json`, or a root editor sidecar that is
 * missing/corrupt/unsupported-version (`captureSidecarForSnapshotLocked`).
 */
async function buildSnapshotIntent(
  ctx: LockedProject,
  transactionId: string,
  id: SnapshotId,
  parent: SnapshotId | null,
  input: CreateSnapshotInput,
  opts?: CreateSnapshotOptions
): Promise<TransactionIntent> {
  const projectRead = await readProjectManifestOrNullLocked(ctx);
  if (projectRead.kind === "corrupt") throw projectRead.error;
  const project = projectRead.kind === "present" ? projectRead.value : null;

  // Normalize to LF-only (Issue #40) BEFORE staging, so the snapshot, root
  // `model.scad`, and the `diff.patch` against the parent all carry identical
  // bytes -- the CLI runner and `--export-format=param` parser then never see
  // a CRLF file the store did not intend.
  const content = normalizeLineEndings(input.content);

  // params.json (Customizer preset format, matching the project root convention)
  const paramsFile: ParamsFile = {
    fileFormatVersion: PARAMS_FILE_FORMAT_VERSION,
    parameterSets: { [PARAMS_ACTIVE_PRESET]: input.params }
  };

  // diff.patch vs parent (null for the first snapshot) -- a READ of the
  // parent's own already-committed, immutable bytes; never touches staging.
  let diffPatch: string | null = null;
  if (parent !== null) {
    const parentContent = await readFile(
      join(snapshotDir(ctx.projectDir, parent), PROJECT_LAYOUT.snapshot.modelFile),
      "utf8"
    ).catch(() => "");
    diffPatch = createTwoFilesPatch(`${parent}/model.scad`, `${id}/model.scad`, parentContent, content);
  }

  // validation.json (verbatim ValidationReport) + the manifest's lightweight summary
  let validationJson: string | null = null;
  let validationSummary: ValidationSummary | null = null;
  if (input.validation) {
    validationJson = JSON.stringify(input.validation.report, null, 2);
    validationSummary = {
      badge: input.validation.gate.badge,
      manifold: input.validation.report.manifold,
      components: input.validation.report.components,
      volume_mm3: input.validation.report.volume_mm3,
      warning_count: input.validation.gate.warnings.length
    };
  }

  // renders -- staged by copying the caller's source PNG bytes; no live
  // caller passes these through `CreateSnapshotInput` today (renders attach
  // AFTER creation via `attachments.ts`), but the shape is preserved.
  const renders: RenderRef[] = [];
  const renderEntries: { view: string; sourcePath: string }[] = [];
  for (const r of input.renders ?? []) {
    const file = `${PROJECT_LAYOUT.snapshot.viewsDir}/${r.view}.png`;
    const { size } = await stat(r.sourcePath);
    // width/height are not re-derived here (the frozen camera contract fixes
    // them per DEFAULT_IMAGE_SIZE / the request's imgsize override); callers
    // that need exact per-file dimensions read them from the RenderResult
    // that produced r.sourcePath.
    renders.push({
      view: r.view,
      file,
      url: input.buildRenderUrl ? input.buildRenderUrl(id, r.view, file) : `/${file}`,
      width: 0,
      height: 0,
      bytes: size,
      render_ms: r.render_ms
    });
    renderEntries.push({ view: r.view, sourcePath: r.sourcePath });
  }

  // editor.json (S3-B B3, Issue #87): every new snapshot -- including
  // ordinary source/params snapshots, not just editor commands -- captures a
  // sidecar verbatim. `captureSidecarForSnapshotLocked` (S3-B ticket B6,
  // Issue #98 F1 fix, PR #103) is a PURE READ: it refuses (never silently
  // drops or fabricates) when the current root sidecar is missing/corrupt/
  // unsupported-version, and otherwise just RETURNS the bytes to stage --
  // it no longer writes anything itself. `opts.sidecar` overrides this
  // default for a caller with its own resulting sidecar (an editor
  // put-feature/remove-feature command, or `revertToSnapshotLocked` copying
  // the target's exact sidecar forward): the caller has already verified
  // (or, for revert, copied wholesale) whatever trustworthiness that sidecar
  // needs, so no extra check is repeated here. Either way, `root.sidecar` is
  // staged and published as PART OF THIS SAME transaction below -- never a
  // separate `writeSidecarBytesLocked` call first. That used to run as its
  // own stage → decide → publish for BOTH the legacy-empty first-mutation
  // case and every revert, so a crash between the two left the root sidecar
  // changed with no snapshot (revert: a MIXED ROOT, the target's sidecar
  // next to the OLD model.scad/params.json) -- the exact defect B8's fault
  // matrix (#103) found.
  const sidecarCapture = opts?.sidecar
    ? (() => {
        const { bytes, digest } = serializeCanonicalSidecar(opts.sidecar!);
        return {
          descriptor: { version: 1 as const, file: "editor.json" as const, sha256: digest },
          bytes,
          legacyMarkerFlip: opts.markerFlip === true
        };
      })()
    : await captureSidecarForSnapshotLocked(ctx);

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
      validation_json: validationJson !== null ? PROJECT_LAYOUT.snapshot.validationFile : null,
      diff_patch: diffPatch !== null ? PROJECT_LAYOUT.snapshot.diffFile : null
    },
    params: input.params,
    renders,
    validation: validationSummary,
    annotations: [],
    editor: sidecarCapture.descriptor
  };

  const updatedProject: ProjectManifest | undefined = project
    ? {
        ...project,
        head: id,
        updated: manifest.timestamp,
        ...(sidecarCapture.legacyMarkerFlip ? { editor_store_version: 1 as const } : {})
      }
    : undefined;

  // S3-B ticket B6: the receipt is built HERE, not by the caller, because
  // `editorRevision`/`sourceRevision` need the id THIS call just claimed as
  // the new `head` — a caller could not have computed them beforehand.
  let receipt: EditorReceipt | undefined;
  if (opts?.editor) {
    const sourceRevision = computeSourceRevision(id, content, input.params);
    const sidecarDigest = sidecarCapture.descriptor.sha256;
    receipt = opts.editor.buildReceipt({
      snapshotId: id,
      sourceRevision,
      sidecarDigest,
      editorRevision: computeEditorRevision(sourceRevision, sidecarDigest)
    });
  }

  return {
    transactionId,
    root: {
      model: content,
      params: paramsFile,
      // Staged unconditionally now (F1 fix): `publishRootFileIdempotent`
      // skips the actual write when the target already matches this exact
      // digest, so re-staging byte-identical bytes on an ordinary
      // (non-sidecar-changing) snapshot is a harmless no-op at publish time
      // -- the alternative (staging it only sometimes) is what produced the
      // separate-transaction defect this fix closes.
      sidecar: sidecarCapture.bytes,
      ...(updatedProject ? { project: updatedProject } : {})
    },
    snapshot: {
      id,
      manifest,
      model: content,
      params: paramsFile,
      message: input.message ?? "",
      diff: diffPatch,
      validation: validationJson,
      sidecar: sidecarCapture.bytes,
      renders: renderEntries
    },
    ...(opts?.editor ? { receipt, claim: opts.editor.claim, accepted: opts.editor.accepted } : {})
  };
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
 * Lists every snapshot manifest, oldest first. A directory with NO
 * `manifest.json` at all is not (yet) a snapshot — an abandoned
 * `claimNextSnapshotId` reservation a crash left behind before any staging
 * transaction started, which `recover()` cannot discover on its own (no
 * transaction is linked to it — Issue #90 correction C2) — and is skipped
 * rather than failing the listing; the NEXT writer either reclaims the same
 * id (Issue #28) or moves past it. A directory whose `manifest.json` EXISTS
 * but is unparseable is genuine corruption and still fails the WHOLE
 * listing, naming the offending id — never a silent skip (Issue #73 AC8): a
 * caller that got a shorter-than-expected list before had no way to know a
 * snapshot was missing versus simply created later.
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
          // See this function's own doc comment (Issue #90 correction C2):
          // no manifest.json at all -> not yet a snapshot, skip; anything
          // else (a manifest.json that exists but fails to parse) is
          // genuine corruption and still fails the whole listing.
          if (ScadForgeError.is(err) && err.error_code === "SNAPSHOT_NOT_FOUND") continue;
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

      // editor.json (S3-B B3, Issue #87): the target's EXACT canonical
      // sidecar bytes are copied forward as the new ROOT sidecar -- never
      // merged with whatever the current root sidecar has (mirrors how
      // model.scad/params.json are wholesale-replaced, never merged, on
      // revert). A pre-S3 target yields the canonical empty sidecar. Refuses
      // when either the target's OWN captured sidecar, or the CURRENT root
      // sidecar this overwrites, is corrupt -- never silently drop/repair
      // either side.
      //
      // S3-B ticket B6 (Issue #98 F1 fix, PR #103): this used to write the
      // root sidecar via its OWN separate `writeSidecarBytesLocked`
      // transaction, BEFORE `createSnapshotLocked` below -- so a crash
      // between the two left a MIXED ROOT (the target's sidecar published
      // next to the OLD model.scad/params.json, no new snapshot at all).
      // The target's sidecar is now passed through `createSnapshotLocked`'s
      // `opts.sidecar`, staged and published as part of the SAME transaction
      // as the snapshot -- the current-root corruption check that
      // `writeSidecarBytesLocked` used to perform internally is replicated
      // here instead, still BEFORE anything is staged.
      const targetSidecar = await readSnapshotSidecarLocked(ctx, targetId);
      if (targetSidecar.status === "corrupt") throw targetSidecar.error;
      const currentSidecar = await readSidecarLocked(ctx);
      if (currentSidecar.status === "corrupt" || currentSidecar.status === "unsupported-version") {
        throw new ScadForgeError(
          "INTERNAL_ERROR",
          `refusing to revert: current root sidecar at '${sidecarPath(ctx.projectDir)}' is ${currentSidecar.status}` +
            (currentSidecar.error ? ` (${currentSidecar.error.message})` : "") +
            "; quarantine the file first, then retry"
        );
      }
      // A still-legacy project reverting (to ANY target, including a pre-S3
      // one) becomes modern going forward -- matches
      // `captureSidecarForSnapshotLocked`'s own "legacy-empty -> flip" rule.
      const revertMarkerFlip = currentSidecar.status === "legacy-empty";

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

      const reverted = await createSnapshotLocked(
        ctx,
        {
          content: modelContent,
          params,
          message: `Revert to ${targetId}`,
          origin: "revert",
          pass: null
        },
        { sidecar: targetSidecar.sidecar, markerFlip: revertMarkerFlip }
      );

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

// ── snapshot-free root params write (S3-B ticket B4) ────────────────────────

/**
 * Writes the project's root `params.json` WITHOUT creating a snapshot — the
 * `snapshot: false` path of `PUT /api/projects/:id/params`, staged through
 * its own transaction (stage → decide → publish, `transaction.ts`) so a
 * crash mid-write is recoverable exactly like every other root writer.
 * Replaces `apps/server`'s former bare `writeRootParamsLocked` (Issue #90:
 * "a snapshot-free params write stages the affected root document[] ...
 * never reconstructing from the old head" — this stages ONLY `params.json`,
 * touching root `model.scad`/`editor.json`/`project.json` not at all).
 *
 * Takes `ctx` (Issue #73): this is a root-state write, so it must run inside
 * an active recovery boundary — its only caller (`scad-core-impl.ts`'s
 * `updateParams`) already holds one via `mergeParamsAtomic`'s `persist`
 * callback.
 */
export async function updateRootParamsLocked(ctx: LockedProject, params: ParamValues): Promise<void> {
  return withTypedError(
    async () => {
      const transactionId = randomUUID();
      try {
        const paramsFile: ParamsFile = {
          fileFormatVersion: PARAMS_FILE_FORMAT_VERSION,
          parameterSets: { [PARAMS_ACTIVE_PRESET]: params }
        };
        const intent: TransactionIntent = { transactionId, root: { params: paramsFile } };
        const staged = await stageTransactionLocked(ctx, intent);
        const decided = await decideLocked(ctx, staged);
        await publishLocked(ctx, decided);
      } catch (err) {
        await reconcileTransactionLocked(ctx, transactionId).catch(() => {});
        throw err;
      }
    },
    "INTERNAL_ERROR",
    "failed to update params"
  );
}
