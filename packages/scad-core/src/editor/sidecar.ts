// @scadforge/scad-core — root and snapshot editor sidecar storage (Issue #87,
// S3-B ticket B3).
//
// The editor's authored feature metadata (`EditorSidecar`) becomes a
// first-class part of the project on disk: a root `.scadforge/editor.json`
// read with one of five EXACT, honest statuses, captured verbatim into every
// new snapshot's `history/<id>/editor.json` + manifest descriptor, and copied
// forward byte-exact (never merged) on revert. Corrupt or forward-incompatible
// bytes are NEVER silently repaired, downgraded, or replaced — the only way
// past them is an explicit `quarantine()` call by a caller that has decided to
// repair the project.
//
// Governing spec: wire-and-recovery §"Disk declarations and one commit
// predicate" and §"Closed recovery boundary and access inventory"
// (`epics/.../s3-s4-plan/s3-contract/wire-and-recovery/`), plus the S3-B
// ticket story's B3 "In scope" bullets.
//
// ── STATUS DERIVATION ORDER (do not "fix" this back to shape-before-version) ──
//
// `readSidecarLocked` checks, in this exact order: (1) the project manifest's
// `editor_store_version` marker — absent/not-1 is `legacy-empty` REGARDLESS of
// whatever bytes `.scadforge/editor.json` might contain (the marker, not file
// presence, is authoritative for legacy vs. modern); (2) whether the file is
// readable at all — `missing`; (3) whether the bytes are valid JSON forming a
// plain object — `corrupt`; (4) a SHALLOW check of `.version !== 1` —
// `unsupported-version`, checked BEFORE the full `parseEditorSidecar` pass;
// only then (5) the full `parseEditorSidecar` validation — a failure here is
// `corrupt`. Step (4) must run before step (5) because `parseEditorSidecar`
// itself enforces `version === 1` as part of its shape validation (it would
// reject a future v2 document as a generic parse failure) — checking the
// version FIRST is what lets a forward-compatible future-version document
// surface as the distinct, non-alarming `unsupported-version` status instead
// of being lumped in with genuine corruption ("unsupported future versions
// disable editing, not downgrade" — wire-and-recovery). Approved verbatim by
// the Tech Lead during B3 plan review (2026-09-14); this ordering is the
// intended reading of the ticket's status-derivation acceptance criterion,
// not an implementation shortcut.
//
// ── UNTRUSTWORTHY STATUSES CARRY NO FABRICATED DATA ─────────────────────────
//
// `missing`, `corrupt` and `unsupported-version` reads return `sidecar: null`
// and `digest: null` — NEVER a placeholder empty sidecar or its digest. A
// caller (a future B6 command handler, B7's agent context) must not be able
// to compute an `editorRevision` from a document that does not actually exist
// on disk, or silently accept a command against fabricated state. Only
// `ready` and `legacy-empty` are "trustworthy": `legacy-empty`'s sidecar IS
// genuinely the canonical empty document (a legacy project has no sidecar at
// all, so "empty" is not a fabrication — it is the honest description of a
// pre-S3 project's editor state).
//
// ── MODULE DEPENDENCY DIRECTION (no cycle with store.ts) ────────────────────
//
// This module never imports from `store.ts`. Reading the project manifest
// and a snapshot's raw manifest are each done with a small LOCAL copy of the
// read logic instead — the same cycle-avoidance convention `attachments.ts`
// already established for its own `readRawManifest` (see that file's header).
// `store.ts` imports FROM this module (one-way: store.ts → sidecar.ts) to
// capture the current sidecar into every new snapshot and to copy a target
// snapshot's sidecar forward on revert.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PROJECT_LAYOUT, parseEditorSidecar } from "@scadforge/protocol";
import type { EditorSidecar, EditorSnapshotRef, ProjectManifest, SnapshotId } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";
import { canonicalJson, canonicalSidecar, sidecarDigest as computeSidecarDigest } from "./canonical.js";
import { metaDir, projectFilePath, snapshotDir } from "../store/paths.js";
import type { LockedProject, ReadResult } from "../store/recovered.js";

/** File name of the sidecar, both at the project root and inside a snapshot directory — comes from `EditorSnapshotRef.file`, not the frozen `PROJECT_LAYOUT` (which has no entry for it; see the ticket's Architecture Constraint Reference). */
const SIDECAR_FILE_NAME = "editor.json";

/** `.scadforge/editor.json` — the root canonical `EditorSidecar`. */
export function sidecarPath(projectDir: string): string {
  return join(metaDir(projectDir), SIDECAR_FILE_NAME);
}

/** `history/<id>/editor.json` — one snapshot's captured sidecar copy. */
export function snapshotSidecarPath(projectDir: string, id: SnapshotId): string {
  return join(snapshotDir(projectDir, id), SIDECAR_FILE_NAME);
}

/** `.scadforge/quarantine/` — corrupt bytes preserved, never deleted. */
function quarantineDir(projectDir: string): string {
  return join(metaDir(projectDir), "quarantine");
}

/** The canonical empty sidecar — a NEW project's explicit starting state, and what a `legacy-empty` read reports. Never used as a placeholder for `missing`/`corrupt`/`unsupported-version` (see the header note). */
export const EMPTY_SIDECAR: EditorSidecar = { version: 1, features: [] };

/**
 * Result of {@link readSidecarLocked} / {@link readSnapshotSidecarLocked}. A
 * discriminated union on `status`: `ready` and `legacy-empty` carry a
 * trustworthy `sidecar`/`digest`; `missing`, `corrupt` and
 * `unsupported-version` carry neither (`null`) — see the header note on why
 * this must never fabricate a placeholder digest for an untrustworthy read.
 */
export type SidecarReadResult =
  | { status: "ready"; sidecar: EditorSidecar; digest: string; error: null }
  | { status: "legacy-empty"; sidecar: EditorSidecar; digest: string; error: null }
  | { status: "missing"; sidecar: null; digest: null; error: null }
  | { status: "corrupt"; sidecar: null; digest: null; error: ScadForgeError }
  | { status: "unsupported-version"; sidecar: null; digest: null; error: null };

// ═════════════════════════════════════════════════════════════════════════════
// Local, cycle-avoiding reads (mirrors store.ts's own private helpers — see
// the header note on why this is duplicated rather than imported)
// ═════════════════════════════════════════════════════════════════════════════

/** Local copy of `store.ts`'s `readProjectManifestOrNullLocked` — see the module header for why this is duplicated instead of imported. */
async function readProjectManifestForSidecar(ctx: LockedProject): Promise<ReadResult<ProjectManifest>> {
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

/** Reads `history/<id>/manifest.json`'s raw `.editor` field (untyped — the caller validates its shape at runtime before trusting it, since a hand-edited manifest is not compile-time checked). Throws for a genuinely unreadable/corrupt MANIFEST (a different failure from a corrupt SIDECAR); returns `undefined` when the manifest has no `editor` field at all (a pre-S3 snapshot). */
async function readRawSnapshotEditorDescriptor(projectDir: string, id: SnapshotId): Promise<unknown> {
  const manifestPath = join(snapshotDir(projectDir, id), PROJECT_LAYOUT.snapshot.manifestFile);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    throw new ScadForgeError("SNAPSHOT_NOT_FOUND", `snapshot '${id}' not found in '${projectDir}'`, { cause: err });
  }
  let manifest: { editor?: unknown };
  try {
    manifest = JSON.parse(raw) as { editor?: unknown };
  } catch (err) {
    throw new ScadForgeError("INTERNAL_ERROR", `snapshot '${id}' manifest at '${manifestPath}' is corrupt`, { cause: err });
  }
  return manifest.editor;
}

// ═════════════════════════════════════════════════════════════════════════════
// Pure canonicalization/serialization (the B4 staged-transaction seam)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Pure: canonicalizes `sidecar` and serializes it to the exact bytes this
 * module persists on disk, plus its B1 digest. No I/O — a staged-transaction
 * writer (B4) can call this directly against a STAGED path with its own
 * temp-file + rename, without depending on any of this module's ctx-coupled,
 * root/history-path-only functions below.
 */
export function serializeCanonicalSidecar(sidecar: EditorSidecar): { canonical: EditorSidecar; bytes: string; digest: string } {
  const canonical = canonicalSidecar(sidecar);
  return { canonical, bytes: canonicalJson(canonical), digest: computeSidecarDigest(canonical) };
}

/** Atomic write via a sibling temp file + rename within the same directory (matches `store.ts`'s `recordExport` / `runner/validate-model.ts`'s own convention). */
async function writeCanonicalBytesToFile(path: string, bytes: string): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, bytes, "utf8");
  await rename(tmpPath, path);
}

// ═════════════════════════════════════════════════════════════════════════════
// readSidecarLocked
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Reads the project's root `.scadforge/editor.json` under the recovery
 * boundary. See the module header for the exact status-derivation order.
 * NEVER writes; corrupt/unsupported bytes are left exactly where they are.
 * Throws only when the PROJECT MANIFEST itself (not the sidecar) is corrupt —
 * that is a different, more fundamental failure this module does not attempt
 * to encode as a sidecar status (consistent with how `store.ts` treats a
 * corrupt `project.json` everywhere else).
 */
export async function readSidecarLocked(ctx: LockedProject): Promise<SidecarReadResult> {
  const projectRead = await readProjectManifestForSidecar(ctx);
  if (projectRead.kind === "corrupt") throw projectRead.error;
  const marker = projectRead.kind === "present" ? projectRead.value.editor_store_version : undefined;
  if (marker !== 1) {
    // No marker (or the project manifest doesn't exist yet, e.g. mid-init) --
    // legacy-empty regardless of whether `.scadforge/editor.json` happens to
    // contain stray bytes; the MARKER, not file presence, is authoritative.
    return { status: "legacy-empty", sidecar: EMPTY_SIDECAR, digest: computeSidecarDigest(EMPTY_SIDECAR), error: null };
  }

  let raw: string;
  try {
    raw = await readFile(sidecarPath(ctx.projectDir), "utf8");
  } catch {
    return { status: "missing", sidecar: null, digest: null, error: null };
  }

  const corrupt = (message: string, cause?: unknown): SidecarReadResult => ({
    status: "corrupt",
    sidecar: null,
    digest: null,
    error: new ScadForgeError(
      "INTERNAL_ERROR",
      `editor sidecar at '${sidecarPath(ctx.projectDir)}' is corrupt: ${message}`,
      cause !== undefined ? { cause } : undefined
    )
  });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return corrupt("bytes are not valid JSON", err);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return corrupt("bytes do not form a JSON object");
  }

  // Step (4): a SHALLOW version check, before the full parse -- see the
  // module header for why this must run first.
  const versionField = (json as { version?: unknown }).version;
  if (versionField !== 1) {
    return { status: "unsupported-version", sidecar: null, digest: null, error: null };
  }

  let parsed: EditorSidecar;
  try {
    parsed = parseEditorSidecar(json);
  } catch (err) {
    return corrupt("bytes fail schema validation", err);
  }

  const canonical = canonicalSidecar(parsed);
  return { status: "ready", sidecar: canonical, digest: computeSidecarDigest(canonical), error: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// writeSidecarBytesLocked / writeSidecarLocked
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Writes ONLY the root `.scadforge/editor.json` bytes (canonical form) via
 * temp-file + rename. Does NOT touch `project.json`'s marker — callers that
 * need to flip it do so themselves ({@link writeSidecarLocked} for an
 * explicit sidecar write; `store.ts`'s `writeSnapshotFiles` for a legacy
 * project's first ordinary snapshot, which flips the marker as part of the
 * SAME `project.json` write it already performs for `head`/`updated`).
 *
 * Refuses to overwrite `corrupt` or `unsupported-version` root bytes (Tech
 * Lead correction C2): silently replacing them would be exactly the kind of
 * data loss this ticket exists to prevent. The only way past them is an
 * explicit {@link quarantine} call, after which the status reads `missing`
 * and this write proceeds normally. Writing over `missing` (nothing to
 * preserve) or `legacy-empty`/`ready` (the normal path) is always allowed.
 */
export async function writeSidecarBytesLocked(
  ctx: LockedProject,
  sidecar: EditorSidecar
): Promise<{ sidecar: EditorSidecar; digest: string }> {
  const current = await readSidecarLocked(ctx);
  if (current.status === "corrupt" || current.status === "unsupported-version") {
    throw new ScadForgeError(
      "INTERNAL_ERROR",
      `refusing to overwrite the editor sidecar at '${sidecarPath(ctx.projectDir)}': current root sidecar is ${current.status}` +
        (current.error ? ` (${current.error.message})` : "") +
        "; quarantine the file first, then retry"
    );
  }
  const { canonical, bytes, digest } = serializeCanonicalSidecar(sidecar);
  await writeCanonicalBytesToFile(sidecarPath(ctx.projectDir), bytes);
  return { sidecar: canonical, digest };
}

/**
 * Writes `sidecar` as the project's canonical root `.scadforge/editor.json`
 * (sidecar bytes first — see {@link writeSidecarBytesLocked}), then, if this
 * is a legacy project's first S3-aware mutation, sets `editor_store_version:
 * 1` on the manifest in the SAME publication, never before it (wire-and-
 * recovery §"Disk declarations"). Never downgrades an already-set marker; a
 * second call on an already-modern project only rewrites the sidecar bytes.
 */
export async function writeSidecarLocked(
  ctx: LockedProject,
  sidecar: EditorSidecar
): Promise<{ sidecar: EditorSidecar; digest: string }> {
  const written = await writeSidecarBytesLocked(ctx, sidecar); // sidecar bytes first — throws before any manifest write if the CURRENT root is corrupt/unsupported.
  const projectRead = await readProjectManifestForSidecar(ctx);
  if (projectRead.kind === "corrupt") throw projectRead.error;
  if (projectRead.kind === "present" && projectRead.value.editor_store_version !== 1) {
    const updated: ProjectManifest = { ...projectRead.value, editor_store_version: 1 }; // manifest second
    await writeFile(projectFilePath(ctx.projectDir), JSON.stringify(updated, null, 2), "utf8");
  }
  return written;
}

// ═════════════════════════════════════════════════════════════════════════════
// readSnapshotSidecarLocked
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The result shape {@link readSnapshotSidecarLocked} actually produces — a
 * narrower slice of {@link SidecarReadResult}: a snapshot's captured sidecar
 * has no separate `missing` (its file either exists or the descriptor itself
 * is absent, i.e. `legacy-empty`) or `unsupported-version` status (this
 * ticket only ever writes version-1 snapshots; a version mismatch on disk is
 * simply `corrupt`). Typing this precisely lets a caller that has excluded
 * `corrupt` (`store.ts`'s revert copy-forward) use `.sidecar` as a non-null
 * `EditorSidecar` without an unsound cast.
 */
export type SnapshotSidecarReadResult = Extract<SidecarReadResult, { status: "ready" | "legacy-empty" | "corrupt" }>;

/**
 * Reads a snapshot's OWN captured sidecar (`history/<id>/editor.json`),
 * verifying it against its immutable manifest descriptor
 * (`SnapshotManifest.editor`). A descriptor is trusted only after every field
 * is independently re-validated against the file's actual bytes — the
 * manifest itself is read with an unchecked cast (`JSON.parse(raw) as
 * SnapshotManifest`), so a hand-tampered `manifest.json` carrying a malformed
 * descriptor (wrong `version`, wrong `file`, or simply mismatched digest)
 * must never be trusted at face value (Tech Lead correction C4).
 *
 * No descriptor at all → `legacy-empty` (a pre-S3 snapshot). Every other
 * failure mode (missing file, unparseable bytes, failed schema validation,
 * malformed descriptor, digest mismatch) → `corrupt`, never empty — a
 * snapshot's history is append-only and immutable, so a broken descriptor can
 * only mean corruption, never "this snapshot legitimately has no sidecar."
 */
export async function readSnapshotSidecarLocked(ctx: LockedProject, id: SnapshotId): Promise<SnapshotSidecarReadResult> {
  const descriptorRaw = await readRawSnapshotEditorDescriptor(ctx.projectDir, id);
  if (descriptorRaw === undefined || descriptorRaw === null) {
    return { status: "legacy-empty", sidecar: EMPTY_SIDECAR, digest: computeSidecarDigest(EMPTY_SIDECAR), error: null };
  }

  const sidecarFilePath = snapshotSidecarPath(ctx.projectDir, id);
  const corrupt = (message: string, cause?: unknown): SnapshotSidecarReadResult => ({
    status: "corrupt",
    sidecar: null,
    digest: null,
    error: new ScadForgeError(
      "INTERNAL_ERROR",
      `snapshot '${id}' editor sidecar at '${sidecarFilePath}' is corrupt: ${message}`,
      cause !== undefined ? { cause } : undefined
    )
  });

  if (typeof descriptorRaw !== "object" || descriptorRaw === null) {
    return corrupt("manifest descriptor is not an object");
  }
  const descriptor = descriptorRaw as Partial<EditorSnapshotRef>;
  if (descriptor.version !== 1 || descriptor.file !== "editor.json" || typeof descriptor.sha256 !== "string") {
    return corrupt(
      `manifest descriptor is malformed (version=${JSON.stringify(descriptor.version)}, file=${JSON.stringify(descriptor.file)}, sha256=${JSON.stringify(descriptor.sha256)})`
    );
  }

  let raw: string;
  try {
    raw = await readFile(sidecarFilePath, "utf8");
  } catch (err) {
    return corrupt("descriptor present but file missing", err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return corrupt("file is not valid JSON", err);
  }
  let parsed: EditorSidecar;
  try {
    // `parseEditorSidecar` itself enforces `version === 1` -- unlike the ROOT
    // sidecar, a snapshot's captured copy has no separate "unsupported
    // future version" status (this ticket only ever WRITES version 1
    // snapshots); any version mismatch here is simply corruption.
    parsed = parseEditorSidecar(json);
  } catch (err) {
    return corrupt("file fails schema validation", err);
  }

  const canonical = canonicalSidecar(parsed);
  const digest = computeSidecarDigest(canonical);
  if (digest !== descriptor.sha256) {
    return corrupt(`digest mismatch: descriptor says '${descriptor.sha256}', file hashes to '${digest}'`);
  }
  return { status: "ready", sidecar: canonical, digest, error: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// captureSidecarForSnapshotLocked — the store.ts seam for writeSnapshotFiles
// ═════════════════════════════════════════════════════════════════════════════

/** What `store.ts`'s `writeSnapshotFiles` needs to embed the current editor sidecar into a NEW snapshot. */
export interface SnapshotSidecarCapture {
  /** The `SnapshotManifest.editor` descriptor for the new snapshot. */
  descriptor: EditorSnapshotRef;
  /** Canonical JSON bytes to write verbatim to the new snapshot's `editor.json`. */
  bytes: string;
  /** True when the caller must ALSO set `project.editor_store_version = 1` on the SAME `project.json` write it already performs (this is a legacy project's first S3-aware mutation). */
  legacyMarkerFlip: boolean;
}

/**
 * Resolves what a NEW snapshot's captured sidecar should be, from the
 * CURRENT root sidecar. Refuses (throws `INTERNAL_ERROR`, naming the status
 * and the absolute path) when the current root sidecar is `missing`,
 * `corrupt` or `unsupported-version` — a snapshot must never silently embed a
 * fabricated or unknown sidecar into permanent history (Tech Lead decision 1,
 * approved 2026-09-14: this blocks ALL snapshot creation, including ordinary
 * `write_scad`/`set_params`, until the root sidecar is repaired).
 *
 * For a `legacy-empty` root, this is the project's first S3-aware mutation
 * (wire-and-recovery: "New projects are modern with explicit empty
 * sidecar"): it establishes the root `.scadforge/editor.json` (canonical
 * empty bytes, via {@link writeSidecarBytesLocked}) BEFORE returning, and
 * sets `legacyMarkerFlip: true` so the caller flips the project manifest's
 * marker in the SAME `project.json` write it already performs for
 * `head`/`updated` — never a second, separate write.
 */
export async function captureSidecarForSnapshotLocked(ctx: LockedProject): Promise<SnapshotSidecarCapture> {
  const read = await readSidecarLocked(ctx);
  // Explicit literal comparisons (not `UNTRUSTWORTHY_STATUSES.includes(...)`)
  // so TypeScript actually narrows the discriminated union below --
  // `Array.prototype.includes` cannot narrow a union the way `===` can.
  if (read.status === "missing" || read.status === "corrupt" || read.status === "unsupported-version") {
    throw new ScadForgeError(
      "INTERNAL_ERROR",
      `cannot create a snapshot: the project's editor sidecar at '${sidecarPath(ctx.projectDir)}' is ${read.status}` +
        (read.error ? `: ${read.error.message}` : "")
    );
  }
  // `read.status` is now narrowed to "ready" | "legacy-empty" -- `sidecar`/`digest` are non-null.
  let sidecar = read.sidecar;
  let digest = read.digest;
  let legacyMarkerFlip = false;
  if (read.status === "legacy-empty") {
    const established = await writeSidecarBytesLocked(ctx, read.sidecar);
    sidecar = established.sidecar;
    digest = established.digest;
    legacyMarkerFlip = true;
  }
  return {
    descriptor: { version: 1, file: "editor.json", sha256: digest },
    bytes: canonicalJson(sidecar),
    legacyMarkerFlip
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// quarantine
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Moves the (presumably corrupt) bytes at `path` aside to
 * `.scadforge/quarantine/<iso>-<basename>`, preserving them for inspection —
 * NEVER deleted. This is the ONLY function in this module that ever moves or
 * overwrites bytes it did not just write itself; every read above leaves
 * corrupt/unsupported bytes exactly where they are, and every write above
 * refuses to proceed over them. Only an explicit caller decision (a future
 * repair route/CLI) invokes this.
 */
export async function quarantine(ctx: LockedProject, path: string): Promise<string> {
  const dir = quarantineDir(ctx.projectDir);
  await mkdir(dir, { recursive: true });
  const iso = new Date().toISOString();
  const dest = join(dir, `${iso}-${basename(path)}`);
  await rename(path, dest);
  return dest;
}
