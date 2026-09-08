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
// REST request/response shapes (PROJECT_CONTEXT.md "API spec": REST + SSE,
// error format `{error_code, message}`, NO pagination in v1, NO auth).
//
// Every route returns either its success body or {@link ApiError}; the error
// body is never nested inside a success envelope. One route file per resource
// (CLAUDE.md hard rule 3) — the groupings below match those files.
// ─────────────────────────────────────────────────────────────────────────────

import type { ApiError } from "./errors.js";
import type { ExportRecord, ProjectManifest, SnapshotId, SnapshotManifest } from "./snapshot.js";
import type { ExportFormat, ParamValue, ParamValues, ViewName } from "./vocabulary.js";

/** Mount point for every REST route below. */
export const API_BASE_PATH = "/api";

/**
 * Route path templates, relative to {@link API_BASE_PATH}. `:param` segments
 * follow Hono's syntax. Grouped by the route file that owns them
 * (CLAUDE.md hard rule 3).
 */
export const API_ROUTES = {
  health: "/health",
  projects: {
    list: "/projects",
    create: "/projects",
    get: "/projects/:projectId"
  },
  chat: {
    /** SSE — responds `text/event-stream`, body is a stream of `SseEvent`. */
    turn: "/projects/:projectId/chat"
  },
  snapshots: {
    list: "/projects/:projectId/snapshots",
    get: "/projects/:projectId/snapshots/:snapshotId",
    diff: "/projects/:projectId/snapshots/:snapshotId/diff",
    revert: "/projects/:projectId/snapshots/:snapshotId/revert"
  },
  renders: {
    create: "/projects/:projectId/renders",
    /** Static file serving for a snapshot's PNGs. */
    file: "/projects/:projectId/snapshots/:snapshotId/views/:view"
  },
  params: {
    get: "/projects/:projectId/params",
    update: "/projects/:projectId/params"
  },
  exports: {
    create: "/projects/:projectId/export",
    file: "/projects/:projectId/exports/:file"
  },
  source: {
    get: "/projects/:projectId/source",
    preflight: "/projects/:projectId/source/preflight",
    update: "/projects/:projectId/source"
  },
  build: {
    create: "/projects/:projectId/build"
  }
} as const;

/** Either the route's success body or the frozen error body. */
export type ApiResponse<T> = T | ApiError;

// ── health ───────────────────────────────────────────────────────────────────

/** `GET /api/health`. */
export interface HealthResponse {
  ok: boolean;
  /** Server package version. */
  version: string;
  /** Pinned OpenSCAD image reference (`repo@sha256:…`), or null if unresolved. */
  openscad_image: string | null;
  /** Human-readable OpenSCAD version, or null when the container is unreachable. */
  openscad_version: string | null;
}

// ── projects ─────────────────────────────────────────────────────────────────

/** `POST /api/projects`. */
export interface CreateProjectRequest {
  name: string;
  /**
   * Optional starting `.scad` source. When omitted the server writes an empty
   * `model.scad` and creates an `initial` snapshot.
   */
  scad?: string;
}

/** `GET /api/projects/:projectId`, and the body of a create response. */
export interface ProjectResponse {
  project: ProjectManifest;
  /** Current `model.scad` contents. */
  scad: string;
  /** Current parameter values. */
  params: ParamValues;
  /** Newest snapshot, or null for a project with no history. */
  head: SnapshotManifest | null;
}

/** `GET /api/projects`. No pagination in v1 (PROJECT_CONTEXT.md). */
export interface ListProjectsResponse {
  projects: ProjectManifest[];
}

// ── chat (SSE) ───────────────────────────────────────────────────────────────

/**
 * An annotated view sent with a chat message (SDP §6.3). Reaches the model as
 * an image block plus a text block naming the view and camera pose, so it can
 * map a 2D arrow to 3D.
 */
export interface ChatImageInput {
  /** BARE base64 — no `data:` URI prefix (Spike 3 §3). */
  data: string;
  mimeType: "image/png" | "image/jpeg";
  /** Which fixed view the annotation was drawn over, if any. */
  view: ViewName | null;
  /** The OpenSCAD `--camera=` string in effect when the image was captured. */
  camera: string | null;
}

/**
 * `POST /api/projects/:projectId/chat`. Responds `text/event-stream`; the body
 * is a stream of `SseEvent` frames.
 */
export interface ChatTurnRequest {
  message: string;
  /** Annotated view composites. Omit or send `[]` for a text-only turn. */
  images?: ChatImageInput[];
  /** Parameter overrides to apply before the turn runs. */
  params?: ParamValues;
  /**
   * Override the per-turn pass budget for this turn only. Clamped server-side;
   * the default comes from `SCADFORGE_MAX_PASSES` (CLAUDE.md hard rule 4).
   */
  max_passes?: number;
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** `GET /api/projects/:projectId/snapshots`. Newest first. No pagination in v1. */
export interface ListSnapshotsResponse {
  snapshots: SnapshotManifest[];
}

/** `GET /api/projects/:projectId/snapshots/:snapshotId`. */
export interface SnapshotResponse {
  snapshot: SnapshotManifest;
  /** The snapshot's captured `model.scad`. */
  scad: string;
}

/** `GET /api/projects/:projectId/snapshots/:snapshotId/diff`. */
export interface SnapshotDiffResponse {
  id: SnapshotId;
  parent: SnapshotId | null;
  /** Unified diff against the parent snapshot; empty string for the first snapshot. */
  diff: string;
}

/**
 * `POST /api/projects/:projectId/snapshots/:snapshotId/revert`. History is
 * append-only: this creates a NEW snapshot with `origin: "revert"` whose files
 * are copied from `:snapshotId` (SDP §8).
 */
export interface RevertRequest {
  /** Optional message for the new snapshot; the server supplies a default. */
  message?: string;
}

// ── params ───────────────────────────────────────────────────────────────────

/**
 * A parameter definition as sent to the UI. Structurally identical to
 * scad-core's `ParamDefinition` (which is the canonical definition and the
 * source of the `--export-format=param` mapping) — repeated here only because
 * `@scadforge/protocol` has zero dependencies. See the MIRROR notice in
 * `vocabulary.ts`.
 */
export interface ParamDefinitionWire {
  name: string;
  type: "number" | "boolean" | "string" | "vector";
  initial: ParamValue;
  caption?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  options?: Array<{ name: string; value: ParamValue }>;
}

/** `GET /api/projects/:projectId/params`. */
export interface ParamsResponse {
  /** `--export-format=param` title (the model's file stem). */
  title: string;
  /** Schema driving the auto-generated slider UI (SDP §9 Params tab). */
  parameters: ParamDefinitionWire[];
  /** Current values from `params.json`. */
  values: ParamValues;
}

/**
 * `PUT /api/projects/:projectId/params`. Partial update: only the named
 * parameters change. Persisted to `params.json` and snapshotted.
 */
export interface ParamsUpdateRequest {
  values: ParamValues;
  /** When true (default) the write creates a `manual` snapshot. */
  snapshot?: boolean;
}

// ── renders ──────────────────────────────────────────────────────────────────

/**
 * `POST /api/projects/:projectId/renders`. Runs the AUTHORITATIVE server render
 * (PROJECT_CONTEXT.md "Render authority"); the WASM preview is convenience only.
 */
export interface RenderViewsRequest {
  /** Defaults to scad-core's `DEFAULT_VIEWS` when omitted. */
  views?: ViewName[];
  /** Parameter overrides for this render only; not persisted. */
  params?: ParamValues;
  /** Defaults to `[1024, 768]` (frozen camera flag set). */
  imgsize?: [number, number];
}

/** One rendered view in a render response. */
export interface RenderedViewResponse {
  view: ViewName;
  ok: boolean;
  /** HTTP path to the PNG; null when this view failed. */
  url: string | null;
  width: number;
  height: number;
  bytes: number | null;
  render_ms: number;
  /**
   * Filtered OpenSCAD diagnostics (`ERROR:`/`WARNING:`/`TRACE:` lines only —
   * Spike 3 §7.2). `null`, never `""`, when there is nothing to report.
   */
  stderr: string | null;
}

/** `POST /api/projects/:projectId/renders`. */
export interface RenderViewsResponse {
  ok: boolean;
  views: RenderedViewResponse[];
  total_ms: number;
  /** The snapshot the renders were attached to, if any. */
  snapshot: SnapshotId | null;
}

// ── export ───────────────────────────────────────────────────────────────────

/**
 * `POST /api/projects/:projectId/export`. Runs `validate_mesh` first and
 * refuses on a red badge unless `allow_validation_failure` is set
 * (CLAUDE.md hard rule 7).
 */
export interface ExportRequest {
  format: ExportFormat;
  /** Parameter overrides for this export only; not persisted. */
  params?: ParamValues;
  /** Explicit override for the validation gate. Defaults to false. */
  allow_validation_failure?: boolean;
}

/** `POST /api/projects/:projectId/export`. */
export interface ExportResponse {
  export: ExportRecord;
  /** Validation state at export time; null when validation could not run. */
  validation: SnapshotManifest["validation"];
}

// ── source (studio code editing) ─────────────────────────────────────────────
//
// Contract addition #54 (lead-approved, delivered in a dedicated contract
// commit). The studio's editable Code tab works against an OPAQUE revision of
// the project's coherent head+source+params state so a save built on stale
// state is rejected (`CONFLICT`) rather than force-overwritten, and so the
// editor can learn exactly which parameter overrides a source edit would
// remove before it commits.

/** `GET /api/projects/:projectId/source`. The project response plus the current revision. */
export interface SourceResponse extends ProjectResponse {
  /**
   * Opaque revision token identifying the coherent head+source+params state
   * this response reflects. Echo it back as `base_revision` to a later
   * preflight/PUT; a mismatch is a `CONFLICT`.
   */
  revision: string;
}

/** `POST /api/projects/:projectId/source/preflight` — a non-mutating dry run. */
export interface SourcePreflightRequest {
  /** Proposed `.scad` source, syntax-checked and analyzed for parameters. */
  scad: string;
  /**
   * The revision the editor currently holds. ENFORCED: a stale revision is
   * `CONFLICT` (the server never silently rebases a draft built on old
   * source). The editor keeps its original `base_revision` unchanged.
   */
  base_revision: string;
}

/**
 * One current parameter override the proposed source edit would DROP. Dropped
 * either because its name is no longer declared, or because its current value
 * is now incompatible (wrong type, out of range, or not an allowed option).
 * `PUT .../source` must explicitly acknowledge each one via
 * `discarded_params` before it will proceed.
 */
export interface RemovedParam {
  name: string;
  /** Human-readable reason (e.g. "no longer declared", "value out of range"). */
  reason: string;
}

/** `POST /api/projects/:projectId/source/preflight`. */
export interface SourcePreflightResponse {
  /** The confirmed current revision — equal to the request's `base_revision`. */
  revision: string;
  syntax_ok: boolean;
  /** `ERROR:` diagnostics; `null`, never `""`, when `syntax_ok` is true. */
  diagnostics: string | null;
  /** Parameters the proposed source declares. Empty when it does not parse. */
  parameters: ParamDefinitionWire[];
  /** Current overrides that survive the proposed source unchanged. */
  retained_params: ParamValues;
  /**
   * Current overrides the proposed source would drop (name no longer declared,
   * or now-incompatible value). Empty when the source does not parse.
   */
  removed_params: RemovedParam[];
}

/** `PUT /api/projects/:projectId/source`. */
export interface SourceUpdateRequest {
  scad: string;
  /** Must equal the server's current revision; a mismatch is `CONFLICT`. */
  base_revision: string;
  /**
   * Names of the current overrides the client explicitly acknowledged
   * discarding (because the new source no longer declares them, or their
   * current value is now incompatible). Must be exactly the set that would
   * actually be dropped; revalidated server-side, never trusted from the
   * client. Invalid syntax is `VALIDATION_FAILED`.
   */
  discarded_params?: string[];
}

// ── build (authoritative snapshot render + validate) ─────────────────────────

/** `POST /api/projects/:projectId/build`. */
export interface BuildRequest {
  /** Must equal the server's current revision; a mismatch is `CONFLICT`. */
  base_revision: string;
}

/** `POST /api/projects/:projectId/build`. */
export interface BuildResponse {
  /** The pinned snapshot, with renders, mesh, and validation attached. */
  snapshot: SnapshotManifest;
}
