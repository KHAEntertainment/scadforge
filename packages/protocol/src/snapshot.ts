// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — ScadForge Issue #13.
//
// This file is Tech-Lead-owned now that Issue #13 has merged (CLAUDE.md hard
// rule 2 / PROJECT_CONTEXT.md "Contract freeze rule"). Do NOT edit it inside a
// feature PR. Changes require a Tech-Lead-approved contract-change issue,
// merged separately before any dependent work.
//
// SPDX-License-Identifier: Apache-2.0
// ─────────────────────────────────────────────────────────────────────────────
//
// The `.scadforge/` on-disk project + history model (SDP §8).
//
//   my-bracket/
//     model.scad
//     params.json
//     .scadforge/
//       project.json
//       history/
//         0001/  message.md  model.scad  params.json  views/*.png
//                validation.json  diff.patch  manifest.json
//         0002/  ...
//       exports/  my-bracket-0002.3mf
//
// History is APPEND-ONLY. A revert copies a snapshot's files forward and
// creates a NEW snapshot; it never rewrites or deletes an existing one.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExportFormat, ParamValues, ValidationBadge, ViewName } from "./vocabulary.js";

/** Directory and file names that make up the on-disk project layout (SDP §8). */
export const PROJECT_LAYOUT = {
  /** Per-project metadata directory, at the project root. */
  metaDir: ".scadforge",
  /** The current model, at the project root (NOT inside `.scadforge/`). */
  modelFile: "model.scad",
  /** Current parameter values, at the project root (Customizer preset format). */
  paramsFile: "params.json",
  /** `.scadforge/project.json` */
  projectFile: "project.json",
  /** `.scadforge/history/` */
  historyDir: "history",
  /** `.scadforge/exports/` */
  exportsDir: "exports",
  /** Files inside one `.scadforge/history/NNNN/` directory. */
  snapshot: {
    manifestFile: "manifest.json",
    messageFile: "message.md",
    modelFile: "model.scad",
    paramsFile: "params.json",
    validationFile: "validation.json",
    diffFile: "diff.patch",
    viewsDir: "views"
  }
} as const;

/**
 * A snapshot identifier: the zero-padded, monotonically increasing directory
 * name under `.scadforge/history/`, e.g. `"0001"`. Four digits minimum; wider
 * once a project exceeds 9999 snapshots.
 */
export type SnapshotId = string;

/** Number of digits `SnapshotId` is zero-padded to. */
export const SNAPSHOT_ID_PAD_WIDTH = 4;

/** What caused a snapshot to be created. */
export type SnapshotOrigin =
  /** An agent turn (`write_scad`). */
  | "agent"
  /** A manual save from the Code tab or a `set_params` write. */
  | "manual"
  /** A "Revert to this" that copied an older snapshot forward. */
  | "revert"
  /** The project's initial snapshot. */
  | "initial"
  /**
   * A committed studio-editor command (S3 `POST …/editor/commands`).
   * Added by the contract fix for B6 (S3-B); additive, no other member changed.
   */
  | "editor";

/**
 * Paths (relative to the snapshot directory) of the files this snapshot
 * captured. `null` when the file was not produced for this snapshot.
 */
export interface SnapshotFiles {
  /** Always present: `model.scad`. */
  model_scad: string;
  /** Always present: `params.json`. */
  params_json: string;
  /** Always present: `message.md` (may hold an empty body). */
  message_md: string;
  /** `validation.json` — null when `validate_mesh` did not run for this snapshot. */
  validation_json: string | null;
  /** `diff.patch` — unified diff vs. the parent snapshot. null for the first snapshot. */
  diff_patch: string | null;
}

/** One rendered PNG belonging to a snapshot. */
export interface RenderRef {
  view: ViewName;
  /** Path relative to the snapshot directory, e.g. `views/iso.png`. */
  file: string;
  /** HTTP path the UI fetches this render from. */
  url: string;
  width: number;
  height: number;
  bytes: number;
  /** Wall-clock ms for this view's OpenSCAD invocation; null if not recorded. */
  render_ms: number | null;
}

/**
 * Index-level validation state carried inside a snapshot manifest so the
 * History list can render a badge without opening every `validation.json`.
 *
 * This is deliberately NOT the full report: the authoritative
 * `ValidationReport` (Spike 4) lives in `packages/scad-core/src/types.ts` and
 * is persisted verbatim to the snapshot's `validation.json`.
 */
export interface ValidationSummary {
  badge: ValidationBadge;
  manifold: boolean;
  /** Disconnected solid components; null when the mesh is not manifold. */
  components: number | null;
  /** null when the mesh is not manifold. */
  volume_mm3: number | null;
  /** Number of non-blocking warnings recorded in `validation.json`. */
  warning_count: number;
}

/**
 * PLACEHOLDER for the Round-3 annotate overlay (SDP §9). `SnapshotManifest.annotations`
 * is always `[]` in v1; the field exists so adding annotations later is not a
 * contract change to the manifest itself.
 */
export interface AnnotationRef {
  id: string;
  /** The view the annotation was drawn on. */
  view: ViewName;
  /** Composite image path relative to the snapshot directory. */
  file: string;
  /** Free-form kind tag (`arrow`, `rect`, `text`, `freehand`) — unconstrained in v1. */
  kind: string;
}

/** `.scadforge/history/NNNN/manifest.json`. */
export interface SnapshotManifest {
  id: SnapshotId;
  /** The snapshot this one was derived from; null for the first snapshot. */
  parent: SnapshotId | null;
  /** ISO-8601 UTC, e.g. `2026-08-26T04:36:49.512Z`. */
  timestamp: string;
  /**
   * One-line summary of the change. The full prose (and any agent narration)
   * lives in `message.md`. NEVER contains a fenced `.scad` block — CLAUDE.md
   * hard rule 5 is enforced host-side before this is written.
   */
  message: string;
  origin: SnapshotOrigin;
  /** Which agent pass produced this snapshot (0 = pre-correction); null when not agent-authored. */
  pass: number | null;
  files: SnapshotFiles;
  /** Parameter values in effect for this snapshot. */
  params: ParamValues;
  renders: RenderRef[];
  /** null when `validate_mesh` did not run for this snapshot. */
  validation: ValidationSummary | null;
  /** Round-3 placeholder — always `[]` in v1. See {@link AnnotationRef}. */
  annotations: AnnotationRef[];
  /**
   * S3-A (Issue #68) additive descriptor for this snapshot's embedded editor
   * sidecar. Set when the snapshot was produced or replayed by the editor
   * surface; missing when the snapshot predates S3 or carries no editable
   * references. Verified host-side: a present descriptor requires a matching
   * `editor.json` whose SHA-256 matches `sha256` under canonical JSON
   * (wire-and-recovery §"Disk declarations and one commit predicate").
   */
  editor?: import("./editor.js").EditorSnapshotRef;
}

/** A file written to `.scadforge/exports/`. */
export interface ExportRecord {
  /** The snapshot this export was produced from. */
  snapshot: SnapshotId;
  format: ExportFormat;
  /** Path relative to `.scadforge/exports/`, e.g. `my-bracket-0002.3mf`. */
  file: string;
  url: string;
  bytes: number;
  /** ISO-8601 UTC. */
  timestamp: string;
  /**
   * True when the export was forced past a red validation badge with an
   * explicit override (CLAUDE.md hard rule 7).
   */
  validation_overridden: boolean;
}

/** Model-provider configuration persisted with the project. */
export interface ProviderConfig {
  /** Provider seam id (SDP §6.4). v1 ships only `claude-agent-sdk`. */
  provider: string;
  /**
   * Requested model id. Advisory only: Spike 3 §2.5 found the SDK always bills
   * an auxiliary `claude-haiku-4-5` call regardless, so this does NOT guarantee
   * single-model execution.
   */
  model: string | null;
  /** Per-turn autonomous self-correction cap (`SCADFORGE_MAX_PASSES`). */
  max_passes: number;
}

/** `.scadforge/project.json`. */
export interface ProjectManifest {
  /** Bump only via a contract-change issue; readers must reject unknown majors. */
  schema_version: 1;
  /** Stable id, unique within the server's project root. */
  id: string;
  /** Human-readable project name. */
  name: string;
  /** ISO-8601 UTC. */
  created: string;
  /** ISO-8601 UTC of the most recent snapshot. */
  updated: string;
  /**
   * The pinned OpenSCAD image this project's renders were produced with —
   * the full `repo@sha256:…` reference, not a floating tag.
   */
  openscad_image: string;
  /** Human-readable OpenSCAD version string, e.g. `2026.01.19 (git e43242666)`. */
  openscad_version: string;
  provider: ProviderConfig;
  /** Id of the newest snapshot, or null for a project with no history yet. */
  head: SnapshotId | null;
  /**
   * S3-A (Issue #68) marker: present and equal to `1` on modern projects
   * that know the editor surface. Absent (or `undefined`) on legacy projects
   * that pre-date S3 — those are treated as `legacy-empty` sidecar status on
   * read and enabled on first S3 mutation (wire-and-recovery §"Disk
   * declarations and one commit predicate"). Server-side writers must NOT
   * downgrade this field once it is present.
   */
  editor_store_version?: 1;
}
