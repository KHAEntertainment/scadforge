// @scadforge/scad-core — DERIVED (mutable) per-snapshot enrichment: renders
// and validation attached AFTER a snapshot's own immutable files were
// written.
//
// Issue #45: a snapshot's `history/<id>/manifest.json`, `validation.json`,
// `model.scad`, `params.json` and `views/` are the append-only historical
// record (`@scadforge/protocol`'s frozen `PROJECT_LAYOUT`) and must NEVER be
// modified once `createSnapshot`'s `writeSnapshotFiles` has written them —
// not "by convention", but because nothing in this package ever opens those
// paths for writing again. Renders and validation that arrive LATER (the
// normal flow: `write_scad` snapshots first, then `render_views` /
// `validate_mesh` run against what was just written) are stored in a
// SIBLING tree, `.scadforge/derived/<id>/`, entirely outside the frozen
// `history/` layout. `store.ts`'s `readSnapshotManifest` merges this
// enrichment into the in-memory `SnapshotManifest` it returns, so every
// consumer (REST routes, the agent adapter, the History tab) still sees
// `.renders` / `.validation` populated exactly as before — the difference is
// entirely in what's on disk, not in the wire shape.
//
// This directory is intentionally NOT part of `@scadforge/protocol`'s
// `PROJECT_LAYOUT`: it is a scad-core-internal implementation detail, not a
// contract any other package should read directly.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RenderRef, SnapshotId, ValidationSummary } from "@scadforge/protocol";
import type { ValidationReport } from "../types.js";
import { metaDir } from "./paths.js";

/** `.scadforge/derived/` — sibling to `history/`, holds mutable post-creation enrichment. */
export function derivedDir(projectDir: string): string {
  return join(metaDir(projectDir), "derived");
}

/** `.scadforge/derived/<id>/` — one snapshot's derived enrichment. */
export function snapshotDerivedDir(projectDir: string, id: SnapshotId): string {
  return join(derivedDir(projectDir), id);
}

/** `.scadforge/derived/<id>/views/` — the physical home of renders attached after creation. */
export function snapshotDerivedViewsDir(projectDir: string, id: SnapshotId): string {
  return join(snapshotDerivedDir(projectDir, id), "views");
}

const RENDERS_INDEX_FILE = "renders.json";
const VALIDATION_SUMMARY_FILE = "validation-summary.json";
const VALIDATION_REPORT_FILE = "validation.json";

/** Physical path of a derived-render PNG (post-creation `attachRendersToSnapshot`). */
export function snapshotDerivedRenderPath(projectDir: string, id: SnapshotId, view: string): string {
  return join(snapshotDerivedViewsDir(projectDir, id), `${view}.png`);
}

/** Physical path of the derived, verbatim `ValidationReport` (post-creation `attachValidationToSnapshot`). */
export function snapshotDerivedValidationReportPath(projectDir: string, id: SnapshotId): string {
  return join(snapshotDerivedDir(projectDir, id), VALIDATION_REPORT_FILE);
}

/** What `readSnapshotManifest` merges into a manifest it read from `history/<id>/manifest.json`. */
export interface DerivedEnrichment {
  /** Null when no render has ever been attached to this snapshot after creation. */
  renders: RenderRef[] | null;
  /** Null when no validation has ever been attached to this snapshot after creation. */
  validation: ValidationSummary | null;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Reads whatever derived enrichment currently exists for `id` (both fields null when none has ever been attached). */
export async function readDerivedEnrichment(projectDir: string, id: SnapshotId): Promise<DerivedEnrichment> {
  const dir = snapshotDerivedDir(projectDir, id);
  const [renders, validation] = await Promise.all([
    readJsonOrNull<RenderRef[]>(join(dir, RENDERS_INDEX_FILE)),
    readJsonOrNull<ValidationSummary>(join(dir, VALIDATION_SUMMARY_FILE))
  ]);
  return { renders, validation };
}

/** Overwrites the derived render index for `id` — the upsert-by-view merge is the caller's job. */
export async function writeDerivedRenders(projectDir: string, id: SnapshotId, renders: readonly RenderRef[]): Promise<void> {
  const dir = snapshotDerivedDir(projectDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, RENDERS_INDEX_FILE), JSON.stringify(renders, null, 2), "utf8");
}

/** Overwrites the derived validation record (verbatim report + summary) for `id`. */
export async function writeDerivedValidation(
  projectDir: string,
  id: SnapshotId,
  report: ValidationReport,
  summary: ValidationSummary
): Promise<void> {
  const dir = snapshotDerivedDir(projectDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, VALIDATION_REPORT_FILE), JSON.stringify(report, null, 2), "utf8");
  await writeFile(join(dir, VALIDATION_SUMMARY_FILE), JSON.stringify(summary, null, 2), "utf8");
}
