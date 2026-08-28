// @scadforge/scad-core — attaching DERIVED artifacts (rendered PNGs, a
// validation report) to an EXISTING snapshot.
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
// ── Why this does NOT break append-only history ─────────────────────────────
//
// `protocol/snapshot.ts`'s append-only rule is about the MODEL timeline: a
// snapshot's `model.scad`, `params.json`, `diff.patch`, `parent` and `id` are
// immutable, and a revert copies forward rather than rewriting. Renders and
// validation are derived FACTS ABOUT that source, not history: re-rendering or
// re-validating `0002` with the pinned image reproduces the same result (Spike
// 2 verified render determinism), so attaching them later cannot change what
// the snapshot means. These functions only ever add/replace `manifest.renders`
// / `manifest.validation` and files under the snapshot's `views/` directory or
// its `validation.json`; they touch no other manifest field and no other file.
//
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import type { RenderRef, SnapshotId, SnapshotManifest } from "@scadforge/protocol";
import type { ValidationResult, ViewName } from "../types.js";
import { withTypedError } from "../errors.js";
import { snapshotDir } from "./paths.js";

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

/** Path of a snapshot's PNG for one view — the canonical `views/<view>.png` convention. */
export function snapshotRenderPath(projectDir: string, snapshotId: SnapshotId, view: ViewName): string {
  return join(snapshotDir(projectDir, snapshotId), PROJECT_LAYOUT.snapshot.viewsDir, `${view}.png`);
}

/** The snapshot's `views/` directory. */
export function snapshotViewsDir(projectDir: string, snapshotId: SnapshotId): string {
  return join(snapshotDir(projectDir, snapshotId), PROJECT_LAYOUT.snapshot.viewsDir);
}

/**
 * Copies `attachments` into `snapshotId`'s `views/` directory and upserts the
 * matching {@link RenderRef} entries into its manifest, keyed by view (a
 * re-render of an already-attached view replaces that view's entry rather than
 * duplicating it). Returns the updated manifest.
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
      const dir = snapshotDir(projectDir, snapshotId);
      const manifestPath = join(dir, PROJECT_LAYOUT.snapshot.manifestFile);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;

      await mkdir(snapshotViewsDir(projectDir, snapshotId), { recursive: true });

      const byView = new Map<string, RenderRef>(manifest.renders.map((r) => [r.view, r]));
      for (const attachment of attachments) {
        const file = `${PROJECT_LAYOUT.snapshot.viewsDir}/${attachment.view}.png`;
        const dest = join(dir, file);
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

      manifest.renders = [...byView.values()];
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      return manifest;
    },
    "SNAPSHOT_NOT_FOUND",
    `failed to attach renders to snapshot '${snapshotId}'`
  );
}

/**
 * Persists a {@link ValidationResult} onto `snapshotId`: writes the full
 * `ValidationReport` verbatim to the snapshot's `validation.json` (the
 * authoritative record — Spike 4's contract) and updates the manifest's
 * lightweight {@link ValidationSummary} plus its `files.validation_json`
 * pointer, which is what the History list renders a badge from.
 *
 * Mirrors exactly what `createSnapshot` writes for its own `validation`
 * input, so a snapshot validated at creation and one validated afterwards are
 * indistinguishable on disk.
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
      const dir = snapshotDir(projectDir, snapshotId);
      const manifestPath = join(dir, PROJECT_LAYOUT.snapshot.manifestFile);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;

      await writeFile(
        join(dir, PROJECT_LAYOUT.snapshot.validationFile),
        JSON.stringify(validation.report, null, 2),
        "utf8"
      );

      manifest.files.validation_json = PROJECT_LAYOUT.snapshot.validationFile;
      manifest.validation = {
        badge: validation.gate.badge,
        manifold: validation.report.manifold,
        components: validation.report.components,
        volume_mm3: validation.report.volume_mm3,
        warning_count: validation.gate.warnings.length
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      return manifest;
    },
    "SNAPSHOT_NOT_FOUND",
    `failed to attach validation to snapshot '${snapshotId}'`
  );
}

/** Absolute path of a snapshot's persisted `ValidationReport`. */
export function snapshotValidationPath(projectDir: string, snapshotId: SnapshotId): string {
  return join(snapshotDir(projectDir, snapshotId), PROJECT_LAYOUT.snapshot.validationFile);
}

// ── the snapshot mesh (ScadForge Issue #41) ──────────────────────────────────
//
// `PROJECT_LAYOUT.snapshot` is part of the FROZEN contract and has no `mesh`
// entry, so the file name lives here rather than being smuggled into
// protocol. Two consequences, both deliberate:
//
//   1. `SnapshotManifest` gains NO mesh field — a snapshot's mesh is
//      discovered by its presence at this well-known path, not by a manifest
//      pointer. Persisting a mesh therefore writes exactly one NEW file and
//      rewrites nothing, which is what keeps it clear of Issue #45 (a
//      re-validation path rewriting historical manifests).
//   2. A snapshot legitimately may have no mesh (nothing ever validated it).
//      Callers must treat "absent" as normal, not as an error.

/** File name of a snapshot's persisted binary STL, inside its snapshot directory. */
export const SNAPSHOT_MESH_FILE = "mesh.stl";

/** Absolute path of a snapshot's persisted binary STL (may not exist — see above). */
export function snapshotMeshPath(projectDir: string, snapshotId: SnapshotId): string {
  return join(snapshotDir(projectDir, snapshotId), SNAPSHOT_MESH_FILE);
}
