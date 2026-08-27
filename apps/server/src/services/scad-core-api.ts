// SPDX-License-Identifier: Apache-2.0
//
// ─────────────────────────────────────────────────────────────────────────────
// SERVICE-BOUNDARY SEAM — apps/server's view of the project store + render/
// export pipeline that `packages/scad-core` implements (Issue #14).
//
// Issue #14 (scad-core runtime) is being built in parallel and does not exist
// on this branch yet. Routes in this package depend ONLY on this interface,
// typed entirely against `@scadforge/protocol`'s frozen wire shapes plus
// scad-core's frozen `types.ts` constants. At integration (Issue #20) the real
// store/runner/validator implementation is wired in here via
// `AppDeps.scadCore` (see app.ts) — no route file changes.
//
// Every method throws `RouteError` (services/errors.ts) with a frozen
// `ScadForgeErrorCode` on failure (e.g. `PROJECT_NOT_FOUND`,
// `SNAPSHOT_NOT_FOUND`, `RENDER_FAILED`) EXCEPT the two file-serving lookups,
// which return `null` for "does not exist" so their routes can 404 without a
// throw/catch round trip.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CreateProjectRequest,
  ExportRequest,
  ExportResponse,
  ListProjectsResponse,
  ParamsResponse,
  ParamsUpdateRequest,
  ProjectResponse,
  RenderViewsRequest,
  RenderViewsResponse,
  RevertRequest,
  SnapshotDiffResponse,
  SnapshotManifest,
  SnapshotResponse
} from "@scadforge/protocol";

/** A binary file served verbatim (a render PNG or an export artifact). */
export interface RenderFile {
  data: Uint8Array;
  contentType: string;
  bytes: number;
}

export interface ScadCoreApi {
  // ── projects ─────────────────────────────────────────────────────────────
  createProject(input: CreateProjectRequest): Promise<ProjectResponse>;
  /** Throws `PROJECT_NOT_FOUND` when the project does not exist. */
  getProject(projectId: string): Promise<ProjectResponse>;
  listProjects(): Promise<ListProjectsResponse>;

  // ── snapshots ────────────────────────────────────────────────────────────
  /** Throws `PROJECT_NOT_FOUND` when the project does not exist. */
  listSnapshots(projectId: string): Promise<SnapshotManifest[]>;
  /** Throws `PROJECT_NOT_FOUND` / `SNAPSHOT_NOT_FOUND`. */
  getSnapshot(projectId: string, snapshotId: string): Promise<SnapshotResponse>;
  /** Throws `PROJECT_NOT_FOUND` / `SNAPSHOT_NOT_FOUND`. */
  getSnapshotDiff(projectId: string, snapshotId: string): Promise<SnapshotDiffResponse>;
  /** Throws `PROJECT_NOT_FOUND` / `SNAPSHOT_NOT_FOUND`. */
  revertSnapshot(projectId: string, snapshotId: string, request: RevertRequest): Promise<SnapshotResponse>;
  /** Returns `null` when the project, snapshot, or view file does not exist. */
  getSnapshotRenderFile(projectId: string, snapshotId: string, view: string): Promise<RenderFile | null>;

  // ── params ───────────────────────────────────────────────────────────────
  //
  // Added at integration (Issue #20): `API_ROUTES.params` is part of the frozen
  // contract and `apps/web`'s Params tab calls it, but no route file existed
  // for it until `routes/params.ts`. The Customizer schema comes from the
  // pinned CLI's `--export-format=param`, so this is a render-path call, not a
  // file read.

  /** Throws `PROJECT_NOT_FOUND`. */
  getParams(projectId: string): Promise<ParamsResponse>;
  /** Throws `PROJECT_NOT_FOUND`; unknown parameter names are ignored, not fatal. */
  updateParams(projectId: string, request: ParamsUpdateRequest): Promise<ParamsResponse>;

  // ── renders ──────────────────────────────────────────────────────────────
  /**
   * Runs the authoritative server render (PROJECT_CONTEXT.md "Render
   * authority"). Throws `PROJECT_NOT_FOUND`; a partial or total render
   * failure is reported through `RenderViewsResponse.views[].ok`/`stderr`,
   * NOT a throw — a failed render must never crash the process.
   */
  renderViews(projectId: string, request: RenderViewsRequest): Promise<RenderViewsResponse>;

  // ── export ───────────────────────────────────────────────────────────────
  /**
   * Throws `PROJECT_NOT_FOUND`, and `VALIDATION_FAILED` when the validation
   * gate refuses the export without `allow_validation_failure` (CLAUDE.md
   * hard rule 7).
   */
  runExport(projectId: string, request: ExportRequest): Promise<ExportResponse>;
  /** Returns `null` when the project or export file does not exist. */
  getExportFile(projectId: string, file: string): Promise<RenderFile | null>;
}
