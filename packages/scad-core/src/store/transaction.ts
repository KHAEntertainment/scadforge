// @scadforge/scad-core — staged roll-forward transactions (Issue #90, S3-B
// ticket B4).
//
// Replaces the bare write sequence every root/history writer used to perform
// with ONE publication mechanism whose sole commit predicate is a durable
// `commit.json`. A transaction stages *complete* new bytes under
// `.scadforge/editor-transactions/<uuid>/`, outside committed state; before
// `commit.json` is durable, NO authoritative root/history file has changed,
// so a crash (or, in tests, an injected fault) before that point can simply
// discard the staging directory and the project is exactly as it was. After
// `commit.json` is durable, the operation is committed and publication MUST
// roll forward — it can never be reported as rejected because publication
// itself failed partway.
//
// Governing spec: wire-and-recovery §"Disk declarations and one commit
// predicate" (`epics/.../s3-s4-plan/s3-contract/wire-and-recovery/`).
//
// ── Durability wording ───────────────────────────────────────────────────
//
// Every flush here is a `FileHandle.sync()` (fsync) call. That is a PROCESS
// RESTART guarantee, never a POWER-LOSS one — macOS's `fsync` does not issue
// the `F_FULLFSYNC` that would be needed for the latter, and Node exposes no
// portable primitive for it. Comments and error messages in this module say
// "process restart" deliberately; never "power loss".
//
// ── Commit-file digests are NOT B1's canonical-JSON digest ──────────────
//
// `commit.json`'s per-file digests are plain SHA-256 hex over each staged
// file's EXACT BYTES (`node:crypto`'s `createHash`), never
// `editor/canonical.ts`'s `digest()` — that function treats a top-level
// `string` argument as raw JSON TEXT to canonicalize (S3-B ticket story
// "Shared seams"), so handing it `model.scad`'s source (not JSON at all)
// would throw or silently mis-hash. `editor/canonical.ts`'s digests stay
// reserved for structured, JSON-shaped values (the sidecar, a future
// receipt) — this module's own file-integrity digests are a completely
// separate, byte-level concern.
//
// ── Recovery reads `commit.json` alone, never the original intent ───────
//
// `decideLocked` folds everything recovery needs (which relative paths were
// staged, which snapshot id if any, which operation id if any) INTO
// `commit.json` itself. `publishLocked` therefore only ever needs `{ dir,
// decision }` — never the original typed `TransactionIntent` — so recovery
// (which only ever has `commit.json` plus the staging directory's own file
// layout to go on, never the in-memory intent that produced them) can call
// the exact same idempotent publish path a fresh commit uses.
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { open as fsOpen, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EditorReceipt, ProjectManifest, SnapshotId, SnapshotManifest } from "@scadforge/protocol";
import { PARAMS_ACTIVE_PRESET } from "../types.js";
import type { ParamValues, ParamsFile } from "../types.js";
import { ScadForgeError, withTypedError } from "../errors.js";
import { canonicalSidecar, editorRevision as computeEditorRevision, sidecarDigest as computeSidecarDigest } from "../editor/canonical.js";
import { EMPTY_SIDECAR } from "../editor/sidecar-empty.js";
import {
  projectFilePath,
  quarantineDir,
  rootModelPath,
  rootParamsPath,
  sidecarPath,
  snapshotDir,
  transactionDir,
  transactionsDir
} from "./paths.js";
import { computeSourceRevision } from "./revision.js";
import type { LockedProject } from "./recovered.js";
import { recordClaimAbortedLocked, recordClaimCommittedLocked } from "./claims.js";

// ═════════════════════════════════════════════════════════════════════════════
// 1. Fault points (Issue #90 AC8) — inert without SCADFORGE_FAULT_POINT
// ═════════════════════════════════════════════════════════════════════════════

/** Every named boundary in the crash table this ticket implements. */
export type FaultPointName =
  | "after-claim"
  | "after-partial-staging"
  | "after-full-staging"
  | "after-commit"
  | "after-publish-history"
  | "after-publish-root-source"
  | "after-publish-root-params"
  | "after-publish-root-sidecar"
  | "after-publish-project"
  | "after-publish-record";

type FaultAction = () => never;

function killSelf(): never {
  process.kill(process.pid, "SIGKILL");
  // Unreachable in production (the signal above terminates the process
  // before this line could run); present only so the function's static
  // return type is `never` without an `as never` cast.
  throw new ScadForgeError("INTERNAL_ERROR", "unreachable: process.kill(SIGKILL) returned");
}

let faultAction: FaultAction = killSelf;

/**
 * TEST-ONLY escape hatch. Deliberately NOT exported from `index.ts` — the
 * package barrel never re-exports it, so no production code path (server,
 * agent, mcp-server) can reach it; only a test file importing this module's
 * relative source path (`transaction.test.ts`, `store.test.ts`) can swap the
 * fault action for a throwing stand-in ("the tests use a helper that throws
 * instead of killing" — Issue #90). Arming itself is STILL env-var-only
 * (`SCADFORGE_FAULT_POINT`); this only changes what happens once armed.
 */
export function __setFaultActionForTests(action: FaultAction | null): void {
  faultAction = action ?? killSelf;
}

/**
 * Fires `name`'s fault action iff `SCADFORGE_FAULT_POINT` names it exactly.
 * Inert (a no-op) without the env var — arming is env-var-only, never
 * reachable from a request/argument a caller controls.
 */
export async function faultPoint(name: FaultPointName): Promise<void> {
  if (process.env.SCADFORGE_FAULT_POINT === name) faultAction();
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Flush primitives — process-restart durability only (see header)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Flushes a file's contents to durable storage. Fails LOUDLY (never silently
 * skips) when the host has no working flush primitive — wire-and-recovery:
 * "if required flush semantics are unavailable, fail qualification; do not
 * silently claim power-loss durability" (here: restart durability).
 */
async function flushFile(path: string): Promise<void> {
  const handle = await fsOpen(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flushes a DIRECTORY's own entries — needed after a create/rename inside it
 * so the directory-entry change itself survives a crash, not merely the
 * file's own bytes. Same fail-loudly contract as {@link flushFile}.
 */
async function flushDir(path: string): Promise<void> {
  const handle = await fsOpen(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFlushed(path: string, data: string | Buffer): Promise<void> {
  await writeFile(path, data);
  await flushFile(path);
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Transaction intent — what a caller wants staged
// ═════════════════════════════════════════════════════════════════════════════

export interface TransactionRootFiles {
  /** Root `model.scad` exact bytes. Omit when this transaction does not touch it. */
  model?: string;
  /** Root `params.json` — full Customizer-preset object; serialized here. */
  params?: ParamsFile;
  /** Root `.scadforge/editor.json` — exact canonical bytes (already produced by `editor/canonical.ts`'s `serializeCanonicalSidecar`). */
  sidecar?: string;
  /** Root `.scadforge/project.json` — the full manifest to publish LAST. */
  project?: ProjectManifest;
}

export interface TransactionSnapshotFiles {
  id: SnapshotId;
  manifest: SnapshotManifest;
  model: string;
  params: ParamsFile;
  message: string;
  diff: string | null;
  /** Verbatim `ValidationReport` JSON text, or null when `validate_mesh` did not run for this snapshot. */
  validation: string | null;
  /** `history/<id>/editor.json` bytes — every snapshot captures one (S3-B ticket B3). */
  sidecar: string;
  renders: readonly { view: string; sourcePath: string }[];
}

/** Links this transaction to a durable operation claim (B6's future editor-command path). No B4 writer sets this today. */
export interface TransactionClaimLink {
  operationId: string;
}

export interface TransactionIntent {
  transactionId: string;
  root: TransactionRootFiles;
  snapshot?: TransactionSnapshotFiles;
  /** Present only for a future editor-command commit (B6). */
  receipt?: EditorReceipt;
  claim?: TransactionClaimLink;
}

export interface StagedTransaction {
  transactionId: string;
  dir: string;
  intent: TransactionIntent;
}

/** The durable, sole commit predicate (wire-and-recovery). Self-describing: `publishLocked`/recovery need nothing but this plus the staging directory. */
export interface CommitDecision {
  version: 1;
  transactionId: string;
  /** Relative path within the transaction dir -> plain SHA-256 hex of that file's EXACT bytes (see the module header on why this is not `editor/canonical.ts`'s `digest()`). */
  files: Record<string, string>;
  snapshotId: SnapshotId | null;
  /** Best-effort/informational — a future receipt's own fields are authoritative once B6 lands. Null when not applicable to this transaction. */
  sourceRevision: string | null;
  editorRevision: string | null;
  receipt: EditorReceipt | null;
  operationId: string | null;
}

export interface DecidedTransaction {
  dir: string;
  decision: CommitDecision;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Staged-file enumeration — the ONE place that knows the on-disk shape
// ═════════════════════════════════════════════════════════════════════════════

interface StagedFileEntry {
  /** e.g. "root/model.scad" or "history/0002/manifest.json". Stable, used as the `commit.json.files` key. */
  relPath: string;
}

function stagedFileEntries(intent: TransactionIntent): StagedFileEntry[] {
  const entries: StagedFileEntry[] = [];
  if (intent.root.model !== undefined) entries.push({ relPath: "root/model.scad" });
  if (intent.root.params !== undefined) entries.push({ relPath: "root/params.json" });
  if (intent.root.sidecar !== undefined) entries.push({ relPath: "root/editor.json" });
  if (intent.root.project !== undefined) entries.push({ relPath: "root/project.json" });
  if (intent.snapshot) {
    const s = intent.snapshot;
    const base = `history/${s.id}`;
    entries.push({ relPath: `${base}/model.scad` });
    entries.push({ relPath: `${base}/params.json` });
    entries.push({ relPath: `${base}/message.md` });
    if (s.diff !== null) entries.push({ relPath: `${base}/diff.patch` });
    if (s.validation !== null) entries.push({ relPath: `${base}/validation.json` });
    entries.push({ relPath: `${base}/editor.json` });
    entries.push({ relPath: `${base}/manifest.json` });
    for (const r of s.renders) entries.push({ relPath: `${base}/views/${r.view}.png` });
  }
  if (intent.receipt !== undefined) entries.push({ relPath: "receipt.json" });
  return entries;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. stageTransactionLocked
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Stages `intent`'s complete new bytes under a fresh
 * `.scadforge/editor-transactions/<uuid>/` directory. Nothing authoritative
 * changes here — every write lands only inside this private directory.
 * Every staged file is flushed before its directory; the transaction
 * directory itself is flushed once staging completes.
 */
export async function stageTransactionLocked(ctx: LockedProject, intent: TransactionIntent): Promise<StagedTransaction> {
  const dir = transactionDir(ctx.projectDir, intent.transactionId);
  await mkdir(dir, { recursive: true });

  // `meta.json` is written FIRST and unconditionally — even a transaction
  // that fails a heartbeat later still leaves this behind, which is what lets
  // recovery's abort path discover a linked claim to mark `aborted` without
  // ever needing the in-memory `TransactionIntent` (Issue #90 AC5/crash-table
  // row 1).
  await writeFlushed(join(dir, "meta.json"), JSON.stringify({ version: 1, operationId: intent.claim?.operationId ?? null }, null, 2));

  let wroteRootFile = false;
  if (intent.root.model !== undefined) {
    await writeFlushed(join(dir, "root", "model.scad"), await withRootDir(dir, "model.scad", intent.root.model));
    wroteRootFile = true;
  }
  if (intent.root.params !== undefined) {
    await writeFlushed(join(dir, "root", "params.json"), await withRootDir(dir, "params.json", JSON.stringify(intent.root.params, null, 2)));
    wroteRootFile = true;
  }
  if (intent.root.sidecar !== undefined) {
    await writeFlushed(join(dir, "root", "editor.json"), await withRootDir(dir, "editor.json", intent.root.sidecar));
    wroteRootFile = true;
  }
  if (intent.root.project !== undefined) {
    await writeFlushed(
      join(dir, "root", "project.json"),
      await withRootDir(dir, "project.json", JSON.stringify(intent.root.project, null, 2))
    );
    wroteRootFile = true;
  }
  if (wroteRootFile) await flushDir(join(dir, "root"));

  await faultPoint("after-partial-staging");

  if (intent.snapshot) {
    const s = intent.snapshot;
    const base = join(dir, "history", s.id);
    const viewsDir = join(base, "views");
    await mkdir(viewsDir, { recursive: true });
    await writeFlushed(join(base, "model.scad"), s.model);
    await writeFlushed(join(base, "params.json"), JSON.stringify(s.params, null, 2));
    await writeFlushed(join(base, "message.md"), s.message);
    if (s.diff !== null) await writeFlushed(join(base, "diff.patch"), s.diff);
    if (s.validation !== null) await writeFlushed(join(base, "validation.json"), s.validation);
    await writeFlushed(join(base, "editor.json"), s.sidecar);
    for (const r of s.renders) {
      const bytes = await readFile(r.sourcePath);
      await writeFlushed(join(viewsDir, `${r.view}.png`), bytes);
    }
    if (s.renders.length > 0) await flushDir(viewsDir);
    // manifest.json LAST among this snapshot's own staged files — a semantic
    // "this snapshot's payload is complete" marker, though nothing reads it
    // as such before publish (publish only ever moves the whole directory at
    // once).
    await writeFlushed(join(base, "manifest.json"), JSON.stringify(s.manifest, null, 2));
    await flushDir(base);
  }

  if (intent.receipt !== undefined) {
    await writeFlushed(join(dir, "receipt.json"), JSON.stringify(intent.receipt, null, 2));
  }

  await flushDir(dir);
  await faultPoint("after-full-staging");

  return { transactionId: intent.transactionId, dir, intent };
}

/** Tiny helper so every root-file write above reads the same at a glance; `mkdir`s `root/` on first use. */
async function withRootDir(txDir: string, _fileName: string, data: string): Promise<string> {
  await mkdir(join(txDir, "root"), { recursive: true });
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. decideLocked — the sole commit predicate
// ═════════════════════════════════════════════════════════════════════════════

async function currentRootProjectHead(ctx: LockedProject): Promise<SnapshotId | null> {
  try {
    const raw = await readFile(projectFilePath(ctx.projectDir), "utf8");
    return (JSON.parse(raw) as ProjectManifest).head ?? null;
  } catch {
    return null;
  }
}

async function currentRootModel(ctx: LockedProject): Promise<string> {
  try {
    return await readFile(rootModelPath(ctx.projectDir), "utf8");
  } catch {
    return "";
  }
}

async function currentRootParamValues(ctx: LockedProject): Promise<ParamValues> {
  try {
    const parsed = JSON.parse(await readFile(rootParamsPath(ctx.projectDir), "utf8")) as ParamsFile;
    return (parsed.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;
  } catch {
    return {};
  }
}

async function currentRootSidecarDigest(ctx: LockedProject): Promise<string | null> {
  try {
    const marker = (JSON.parse(await readFile(projectFilePath(ctx.projectDir), "utf8")) as ProjectManifest)
      .editor_store_version;
    if (marker !== 1) return computeSidecarDigest(EMPTY_SIDECAR); // legacy-empty is still a trustworthy digest
    const raw = await readFile(sidecarPath(ctx.projectDir), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (parsed.version !== 1) return null; // unsupported-version — not trustworthy
    return computeSidecarDigest(canonicalSidecar(parsed as never));
  } catch {
    return null; // missing/corrupt — not trustworthy; informational field only, never blocks the transaction
  }
}

/**
 * Computes the transaction's per-file digests and (best-effort, informational
 * only) its resulting source/editor revision, then writes `commit.json` —
 * the sole durable commit predicate — via temp-file, flush, rename, flush
 * the transaction directory. Nothing authoritative outside the transaction
 * directory has changed when this returns; the operation is now committed.
 */
export async function decideLocked(ctx: LockedProject, staged: StagedTransaction): Promise<DecidedTransaction> {
  const { dir, intent } = staged;
  const files: Record<string, string> = {};
  for (const entry of stagedFileEntries(intent)) {
    const bytes = await readFile(join(dir, entry.relPath));
    files[entry.relPath] = sha256Hex(bytes);
  }

  let sourceRevision: string | null = null;
  if (intent.root.model !== undefined || intent.root.params !== undefined) {
    const head = intent.root.project ? intent.root.project.head : await currentRootProjectHead(ctx);
    const scad = intent.root.model ?? (await currentRootModel(ctx));
    const params: ParamValues = intent.root.params
      ? ((intent.root.params.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues)
      : await currentRootParamValues(ctx);
    sourceRevision = computeSourceRevision(head, scad, params);
  }

  let editorRevision: string | null = null;
  const sidecarDigestForRevision = intent.root.sidecar
    ? computeSidecarDigest(canonicalSidecar(JSON.parse(intent.root.sidecar) as never))
    : await currentRootSidecarDigest(ctx);
  if (sidecarDigestForRevision !== null) {
    const sourceRevisionForEditor =
      sourceRevision ??
      computeSourceRevision(await currentRootProjectHead(ctx), await currentRootModel(ctx), await currentRootParamValues(ctx));
    editorRevision = computeEditorRevision(sourceRevisionForEditor, sidecarDigestForRevision);
  }

  const decision: CommitDecision = {
    version: 1,
    transactionId: intent.transactionId,
    files,
    snapshotId: intent.snapshot?.id ?? null,
    sourceRevision,
    editorRevision,
    receipt: intent.receipt ?? null,
    operationId: intent.claim?.operationId ?? null
  };

  const commitPath = join(dir, "commit.json");
  const tmp = `${commitPath}.tmp`;
  await writeFile(tmp, JSON.stringify(decision, null, 2), "utf8");
  await flushFile(tmp);
  await rename(tmp, commitPath);
  await flushDir(dir);
  await faultPoint("after-commit");

  return { dir, decision };
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. publishLocked — idempotent, drivable by a fresh commit OR recovery
// ═════════════════════════════════════════════════════════════════════════════

async function digestOfFile(path: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(path));
  } catch {
    return null;
  }
}

async function publishRootFileIdempotent(stagePath: string, targetPath: string, expectedDigest: string): Promise<void> {
  if ((await digestOfFile(targetPath)) === expectedDigest) return; // already published
  const bytes = await readFile(stagePath);
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, bytes);
  await flushFile(tmp);
  await rename(tmp, targetPath);
  await flushDir(dirname(targetPath));
}

async function publishHistoryDirIdempotent(stagedDir: string, realDir: string): Promise<void> {
  const alreadyPublished = await stat(join(realDir, "manifest.json")).then(
    () => true,
    () => false
  );
  if (alreadyPublished) return;
  await rename(stagedDir, realDir);
  await flushDir(dirname(realDir));
}

const ROOT_FILE_TARGET: Record<string, (projectDir: string) => string> = {
  "root/model.scad": rootModelPath,
  "root/params.json": rootParamsPath,
  "root/editor.json": sidecarPath,
  "root/project.json": projectFilePath
};

/**
 * Publishes a decided transaction in the spec's fixed order: the immutable
 * snapshot directory by rename, then root source/params/sidecar by
 * temp-file rename, then `project.json` last, then the linked operation
 * claim's terminal state, then redundant-staging cleanup. Every step first
 * checks whether its target already reflects the staged bytes, so recovery
 * can safely re-run this from any partially-published state.
 */
export async function publishLocked(ctx: LockedProject, staged: DecidedTransaction): Promise<void> {
  const { dir, decision } = staged;
  const projectDir = ctx.projectDir;

  if (decision.snapshotId !== null) {
    await publishHistoryDirIdempotent(join(dir, "history", decision.snapshotId), snapshotDir(projectDir, decision.snapshotId));
    await faultPoint("after-publish-history");
  }

  const rootOrder: FaultPointName[] = ["after-publish-root-source", "after-publish-root-params", "after-publish-root-sidecar"];
  const rootRelPaths = ["root/model.scad", "root/params.json", "root/editor.json"];
  for (let i = 0; i < rootRelPaths.length; i++) {
    const relPath = rootRelPaths[i]!;
    const digest = decision.files[relPath];
    if (digest === undefined) continue;
    await publishRootFileIdempotent(join(dir, relPath), ROOT_FILE_TARGET[relPath]!(projectDir), digest);
    await faultPoint(rootOrder[i]!);
  }

  const projectDigest = decision.files["root/project.json"];
  if (projectDigest !== undefined) {
    await publishRootFileIdempotent(join(dir, "root/project.json"), projectFilePath(projectDir), projectDigest);
    await faultPoint("after-publish-project");
  }

  if (decision.operationId !== null && decision.receipt !== null) {
    await recordClaimCommittedLocked(ctx, decision.operationId, {
      receipt: decision.receipt,
      transactionId: decision.transactionId
    });
    await faultPoint("after-publish-record");
  }

  await rm(dir, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. Recovery — the crash-boundary table (Issue #90 AC4)
// ═════════════════════════════════════════════════════════════════════════════

function isoSafeStamp(): string {
  return new Date().toISOString().replace(/:/g, "-");
}

async function readStagedSnapshotIdBestEffort(dir: string): Promise<SnapshotId | null> {
  try {
    const names = (await readdir(join(dir, "history"), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    return names.length === 1 ? (names[0] as SnapshotId) : null;
  } catch {
    return null;
  }
}

/**
 * Row 1 of the crash table: a transaction with NO durable `commit.json`.
 * Definitely not committed — old state is untouched. Marks the linked claim
 * (if any) `aborted`, quarantines the staging directory (never deletes it —
 * preserved for inspection), and removes the CLAIMED (but never staged-into)
 * `history/<id>` directory from `claimNextSnapshotId`'s reservation, but only
 * when it is still completely empty — never a non-empty one, and this
 * function is only ever reached for a transaction WITHOUT `commit.json`, so
 * it never touches anything a commit decision names.
 *
 * `knownSnapshotId`, when supplied, is used instead of the staging
 * directory's own (possibly-nonexistent, if staging never even began)
 * `history/` listing — the synchronous in-process cleanup path in
 * `store.ts` already knows which id it claimed before this ever ran.
 */
export async function abortTransactionLocked(
  ctx: LockedProject,
  transactionId: string,
  knownSnapshotId?: SnapshotId | null
): Promise<void> {
  const dir = transactionDir(ctx.projectDir, transactionId);

  let operationId: string | null = null;
  try {
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as { operationId?: string | null };
    operationId = meta.operationId ?? null;
  } catch {
    operationId = null; // never durably written (crash before even that) — nothing to mark
  }
  if (operationId !== null) {
    await recordClaimAbortedLocked(ctx, operationId).catch(() => {});
  }

  const stagingExists = await stat(dir).then(
    () => true,
    () => false
  );
  let quarantinedDir: string | null = null;
  if (stagingExists) {
    await mkdir(quarantineDir(ctx.projectDir), { recursive: true });
    quarantinedDir = join(quarantineDir(ctx.projectDir), `${isoSafeStamp()}-tx-${transactionId}`);
    await rename(dir, quarantinedDir);
  }

  const snapshotId = knownSnapshotId ?? (quarantinedDir ? await readStagedSnapshotIdBestEffort(quarantinedDir) : null);
  if (snapshotId) {
    const realDir = snapshotDir(ctx.projectDir, snapshotId);
    const isEmpty = await readdir(realDir).then(
      (names) => names.length === 0,
      () => false
    );
    if (isEmpty) await rm(realDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Verifies every staged file `commit.json` names still matches its recorded
 * digest before finishing publication — row 4 of the crash table ("commit.json
 * present but required staged bytes missing or digest mismatch"). A file
 * under an ALREADY-published `history/<id>` is expected to be gone (the
 * publish step MOVES that directory, it does not copy it) and is skipped
 * rather than treated as tampering.
 */
async function verifyStagedDigestsOrThrow(
  ctx: LockedProject,
  dir: string,
  decision: CommitDecision,
  transactionId: string
): Promise<void> {
  const historyAlreadyPublished =
    decision.snapshotId !== null
      ? await stat(join(snapshotDir(ctx.projectDir, decision.snapshotId), "manifest.json")).then(
          () => true,
          () => false
        )
      : false;
  const historyPrefix = decision.snapshotId !== null ? `history/${decision.snapshotId}/` : null;

  for (const [relPath, expected] of Object.entries(decision.files)) {
    if (historyAlreadyPublished && historyPrefix !== null && relPath.startsWith(historyPrefix)) continue;
    let actual: string;
    try {
      actual = sha256Hex(await readFile(join(dir, relPath)));
    } catch (err) {
      throw new ScadForgeError(
        "INTERNAL_ERROR",
        `staged transaction '${transactionId}' commit.json names '${relPath}' but it is missing or unreadable; preserving everything for inspection`,
        { cause: err }
      );
    }
    if (actual !== expected) {
      throw new ScadForgeError(
        "INTERNAL_ERROR",
        `staged transaction '${transactionId}' file '${relPath}' does not match its commit.json digest (expected ${expected}, got ${actual}); preserving everything for inspection`
      );
    }
  }
}

/**
 * Reconciles ONE transaction directory against the crash table: absent/
 * unreadable `commit.json` → abort (row 1); present → verify then finish
 * publication idempotently (rows 2/3), or refuse loudly on tampering (row
 * 4). Used both by the full boundary-entry recovery scan
 * ({@link recoverTransactionsLocked}) and, synchronously, by a writer that
 * failed mid-pipeline in the SAME process (no crash) — see `store.ts`'s
 * `createSnapshotLocked`, which calls this immediately in its own `catch`
 * rather than waiting for the next boundary entry.
 */
export async function reconcileTransactionLocked(
  ctx: LockedProject,
  transactionId: string,
  knownSnapshotId?: SnapshotId | null
): Promise<void> {
  const dir = transactionDir(ctx.projectDir, transactionId);
  let decision: CommitDecision | null = null;
  try {
    decision = JSON.parse(await readFile(join(dir, "commit.json"), "utf8")) as CommitDecision;
  } catch {
    decision = null;
  }

  if (decision === null) {
    await abortTransactionLocked(ctx, transactionId, knownSnapshotId);
    return;
  }

  await verifyStagedDigestsOrThrow(ctx, dir, decision, transactionId);
  await publishLocked(ctx, { dir, decision });
}

/**
 * `recovered.ts`'s B4 body for B2's `recover(ctx)` hook: reconciles every
 * staged transaction found under `.scadforge/editor-transactions/` against
 * the crash table, run before any read or write on every boundary entry. A
 * project with no such directory (the overwhelming common case) returns
 * immediately.
 */
export async function recoverTransactionsLocked(ctx: LockedProject): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(transactionsDir(ctx.projectDir), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return; // no editor-transactions/ directory at all
  }
  for (const transactionId of entries) {
    await withTypedError(() => reconcileTransactionLocked(ctx, transactionId), "INTERNAL_ERROR", `failed to recover transaction '${transactionId}'`);
  }
}
