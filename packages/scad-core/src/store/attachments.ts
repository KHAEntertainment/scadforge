// @scadforge/scad-core — attaching DERIVED artifacts (rendered PNGs, a
// validation report) to an EXISTING snapshot, WITHOUT ever rewriting that
// snapshot's own immutable files (Issue #45).
//
// GLUE (Issue #20). `createSnapshot` can take renders and a validation report
// at creation time, but the real flow does not work that way: `write_scad`
// snapshots FIRST (so the source is durable even if the render then fails),
// and `render_views` / `validate_mesh` run afterwards, against the snapshot
// that already exists. The same is true of `POST /api/projects/:id/renders`,
// which re-renders the current head on demand with no new source to snapshot.
//
// Without this, `SnapshotManifest.validation` and `.renders` would be
// permanently null/empty for every agent-authored snapshot: the History tab
// would have no badge and no thumbnails, and `ExportResponse.validation` would
// always be null.
//
// ── Issue #45 (was): this used to write directly into
// `history/<id>/manifest.json` / `validation.json` / `views/*.png` — i.e.
// rewrite a historical snapshot's own files after creation. That IS a
// history rewrite, full stop: it is exactly how a snapshot's recorded
// validation was observed changing ~7 minutes after the snapshot was
// created, for a `model.scad` that never changed. The prior header comment's
// argument ("re-rendering/re-validating the same source reproduces the same
// result, so this isn't really a rewrite") does not hold once the caller —
// racing against a concurrent `write_scad`, or simply validating with
// different params — is no longer guaranteed to be looking at THIS
// snapshot's own persisted `model.scad`/`params.json`. See
// `apps/server/src/services/agent-scad-core.ts` and `scad-core-impl.ts` for
// the corresponding fix (pin the target snapshot id and read ITS OWN files
// BEFORE running OpenSCAD, never the project's current root state).
//
// ── The fix: `history/<id>/` is now write-once ───────────────────────────
//
// These functions no longer touch `history/<id>/manifest.json`,
// `validation.json` or `views/*.png` at all. They write into a SIBLING,
// non-frozen tree instead: `.scadforge/derived/<id>/` (see `derived.ts`).
// `store.ts`'s `readSnapshotManifest` merges that enrichment into the
// `SnapshotManifest` it returns, so every consumer still sees `.renders` /
// `.validation` populated — the wire shape is unchanged, only where the bytes
// physically live. `history/<id>/` is therefore checksummable and provably
// unchanged for the lifetime of the project (see `attachments.test.ts` and
// `store.test.ts`'s byte-identical regression tests).
//
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import type { RenderRef, SnapshotId, SnapshotManifest } from "@scadforge/protocol";
import type { ValidationResult, ViewName } from "../types.js";
import { withTypedError } from "../errors.js";
import { snapshotDir } from "./paths.js";
import {
  readDerivedEnrichment,
  snapshotDerivedRenderPath,
  snapshotDerivedValidationReportPath,
  snapshotDerivedViewsDir,
  writeDerivedRenders,
  writeDerivedValidation
} from "./derived.js";

/** One rendered PNG to attach. */
export interface RenderAttachment {
  view: ViewName;
  /** Absolute host path to the PNG produced by `renderViews`. */
  sourcePath: string;
  render_ms: number | null;
  width: number;
  height: number;
}

/** Options for {@link attachRendersToSnapshot}. */
export interface AttachRendersOptions {
  /**
   * Builds the HTTP URL the UI fetches a render from. `apps/server` owns the
   * URL space; scad-core defaults to a bare relative path when the caller
   * does not supply one (same convention as `CreateSnapshotInput`).
   */
  buildRenderUrl?: (snapshotId: SnapshotId, view: ViewName, file: string) => string;
}

/**
 * Physical path of a snapshot's PNG for one view — the DERIVED (post-creation
 * attach) location. A snapshot's `history/<id>/views/` stays whatever it was
 * at creation (normally empty; see the header comment) and is never the
 * target of a later render attach.
 *
 * This is the WRITE-time / just-attached location, used by
 * `attachRendersToSnapshot` itself and by callers re-pointing at a render
 * they just attached in this same call (guaranteed to exist there). For
 * READING a render that might pre-date this fix, use
 * {@link resolveSnapshotRenderPath} instead.
 */
export function snapshotRenderPath(projectDir: string, snapshotId: SnapshotId, view: ViewName): string {
  return snapshotDerivedRenderPath(projectDir, snapshotId, view);
}

/** The snapshot's derived `views/` directory — where `attachRendersToSnapshot` copies PNGs. */
export function snapshotViewsDir(projectDir: string, snapshotId: SnapshotId): string {
  return snapshotDerivedViewsDir(projectDir, snapshotId);
}

/** History (creation-time) path for a snapshot's rendered PNG. Populated for a LEGACY snapshot whose renders were attached by the pre-Issue-#45 code directly into `history/<id>/views/`, or for the rare snapshot created with `CreateSnapshotInput.renders` already supplied. */
function snapshotHistoryRenderPath(projectDir: string, snapshotId: SnapshotId, view: ViewName): string {
  return join(snapshotDir(projectDir, snapshotId), PROJECT_LAYOUT.snapshot.viewsDir, `${view}.png`);
}

/** History (creation-time) path for a snapshot's persisted `ValidationReport`. See {@link snapshotHistoryRenderPath}. */
function snapshotHistoryValidationPath(projectDir: string, snapshotId: SnapshotId): string {
  return join(snapshotDir(projectDir, snapshotId), PROJECT_LAYOUT.snapshot.validationFile);
}

async function existsFile(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the PHYSICAL path to READ a snapshot's rendered PNG for `view`
 * from — the DERIVED (post-Issue-#45) location if present, else falling back
 * to `history/<id>/views/<view>.png` for a project that predates this fix
 * (whose renders the pre-fix code attached directly into `history/`).
 * Read-only: never writes, never migrates the legacy file forward, so an
 * existing project's on-disk layout is untouched either way. Returns `null`
 * when the render exists in neither location.
 */
export async function resolveSnapshotRenderPath(
  projectDir: string,
  snapshotId: SnapshotId,
  view: ViewName
): Promise<string | null> {
  const derived = snapshotDerivedRenderPath(projectDir, snapshotId, view);
  if (await existsFile(derived)) return derived;
  const legacy = snapshotHistoryRenderPath(projectDir, snapshotId, view);
  if (await existsFile(legacy)) return legacy;
  return null;
}

/** Same read-time fallback as {@link resolveSnapshotRenderPath}, for a snapshot's persisted `ValidationReport` bytes. */
export async function resolveSnapshotValidationPath(
  projectDir: string,
  snapshotId: SnapshotId
): Promise<string | null> {
  const derived = snapshotDerivedValidationReportPath(projectDir, snapshotId);
  if (await existsFile(derived)) return derived;
  const legacy = snapshotHistoryValidationPath(projectDir, snapshotId);
  if (await existsFile(legacy)) return legacy;
  return null;
}

/** Reads a snapshot's raw (immutable) manifest without going through `store.ts`'s derived-merge, to avoid a circular import. */
async function readRawManifest(projectDir: string, snapshotId: SnapshotId): Promise<SnapshotManifest> {
  const manifestPath = join(snapshotDir(projectDir, snapshotId), PROJECT_LAYOUT.snapshot.manifestFile);
  const raw = await readFile(manifestPath, "utf8").catch(() => {
    throw new Error(`snapshot '${snapshotId}' not found`);
  });
  return JSON.parse(raw) as SnapshotManifest;
}

/**
 * Copies `attachments` into `snapshotId`'s DERIVED `views/` directory
 * (`.scadforge/derived/<id>/views/`, never `history/<id>/views/`) and upserts
 * the matching {@link RenderRef} entries into its derived render index, keyed
 * by view (a re-render of an already-attached view replaces that view's entry
 * rather than duplicating it). Returns the snapshot's manifest with this
 * enrichment merged in. `history/<id>/manifest.json` is never opened for
 * writing by this function.
 *
 * Rejects only with a typed `ScadForgeError`.
 */
export async function attachRendersToSnapshot(
  projectDir: string,
  snapshotId: SnapshotId,
  attachments: readonly RenderAttachment[],
  options: AttachRendersOptions = {}
): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const manifest = await readRawManifest(projectDir, snapshotId);

      const viewsDir = snapshotDerivedViewsDir(projectDir, snapshotId);
      await mkdir(viewsDir, { recursive: true });

      const existing = await readDerivedEnrichment(projectDir, snapshotId);
      const byView = new Map<string, RenderRef>((existing.renders ?? manifest.renders).map((r) => [r.view, r]));
      for (const attachment of attachments) {
        const file = `${PROJECT_LAYOUT.snapshot.viewsDir}/${attachment.view}.png`;
        const dest = snapshotDerivedRenderPath(projectDir, snapshotId, attachment.view);
        if (attachment.sourcePath !== dest) await copyFile(attachment.sourcePath, dest);
        const { size } = await stat(dest);
        byView.set(attachment.view, {
          view: attachment.view,
          file,
          url: options.buildRenderUrl ? options.buildRenderUrl(snapshotId, attachment.view, file) : `/${file}`,
          width: attachment.width,
          height: attachment.height,
          bytes: size,
          render_ms: attachment.render_ms
        });
      }

      const renders = [...byView.values()];
      await writeDerivedRenders(projectDir, snapshotId, renders);

      manifest.renders = renders;
      return manifest;
    },
    "SNAPSHOT_NOT_FOUND",
    `failed to attach renders to snapshot '${snapshotId}'`
  );
}

/**
 * Persists a {@link ValidationResult} for `snapshotId`: writes the full
 * `ValidationReport` verbatim to `.scadforge/derived/<id>/validation.json`
 * (never `history/<id>/validation.json`) and a {@link ValidationSummary} the
 * History list renders a badge from. Returns the snapshot's manifest with
 * this enrichment merged in. `history/<id>/manifest.json` and
 * `history/<id>/validation.json` are never opened for writing by this
 * function.
 *
 * Rejects only with a typed `ScadForgeError`.
 */
export async function attachValidationToSnapshot(
  projectDir: string,
  snapshotId: SnapshotId,
  validation: ValidationResult
): Promise<SnapshotManifest> {
  return withTypedError(
    async () => {
      const manifest = await readRawManifest(projectDir, snapshotId);

      const summary = {
        badge: validation.gate.badge,
        manifold: validation.report.manifold,
        components: validation.report.components,
        volume_mm3: validation.report.volume_mm3,
        warning_count: validation.gate.warnings.length
      };
      await writeDerivedValidation(projectDir, snapshotId, validation.report, summary);

      // `files.validation_json` is a logical pointer (SDP §8): nothing joins
      // it against `snapshotDir` to physically locate the file (that's what
      // `snapshotValidationPath` is for, and it now resolves to the derived
      // location) so recording the frozen file-name convention here is still
      // accurate for readers that only care "was there ever a validation".
      manifest.files = { ...manifest.files, validation_json: PROJECT_LAYOUT.snapshot.validationFile };
      manifest.validation = summary;
      return manifest;
    },
    "SNAPSHOT_NOT_FOUND",
    `failed to attach validation to snapshot '${snapshotId}'`
  );
}

/**
 * Absolute path of a snapshot's persisted `ValidationReport` — the DERIVED
 * (post-creation attach) location. This is the WRITE-time location; for
 * READING a validation report that might pre-date this fix, use
 * {@link resolveSnapshotValidationPath} instead.
 */
export function snapshotValidationPath(projectDir: string, snapshotId: SnapshotId): string {
  return snapshotDerivedValidationReportPath(projectDir, snapshotId);
}
