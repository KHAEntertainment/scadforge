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
  BuildRequest,
  BuildResponse,
  CreateProjectRequest,
  EditorProofResponse,
  EditorVerifyRequest,
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
  SnapshotResponse,
  SourcePreflightRequest,
  SourcePreflightResponse,
  SourceResponse,
  SourceUpdateRequest
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
  /**
   * The snapshot's persisted binary STL, for the three.js viewer (Issue #41).
   *
   * Returns `null` when the project or snapshot does not exist AND when the
   * snapshot simply has no mesh — a snapshot that was never validated has
   * none, and that is an ordinary state, not a failure.
   */
  getSnapshotMeshFile(projectId: string, snapshotId: string): Promise<RenderFile | null>;

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

  // ── source (studio code editing, Issue #54) ──────────────────────────────
  /** Throws `PROJECT_NOT_FOUND`. */
  getSource(projectId: string): Promise<SourceResponse>;
  /**
   * Non-mutating dry run: syntax-checks a proposed source edit and reports
   * which current overrides it would drop. Throws `CONFLICT` on a stale
   * `base_revision`; a source that does not parse is reported as
   * `syntax_ok: false` (never a throw).
   */
  preflightSource(projectId: string, request: SourcePreflightRequest): Promise<SourcePreflightResponse>;
  /**
   * CAS save. Throws `CONFLICT` on a stale `base_revision`; `VALIDATION_FAILED`
   * on invalid syntax or a `discarded_params` set that does not exactly match
   * the overrides the save would drop. Creates one `manual` snapshot.
   */
  updateSource(projectId: string, request: SourceUpdateRequest): Promise<SourceResponse>;

  // ── build (authoritative render + validate, Issue #54) ───────────────────
  /**
   * Renders + validates the pinned head snapshot and attaches the results to
   * it. Throws `CONFLICT` on a stale `base_revision`; a total render failure
   * or a mesh export/validation failure is a typed error — never a fake
   * success.
   */
  build(projectId: string, request: BuildRequest): Promise<BuildResponse>;

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

  // ── editor (S3-B B5, Issue #91) ──────────────────────────────────────────
  /**
   * Server-authorized proof that `request.command` produces the geometry its
   * binding claims, run outside any lock and persisted with a 10-minute TTL.
   * Throws `PROJECT_NOT_FOUND`; `CONFLICT` on a stale `baseEditorRevision` or
   * when the sidecar status does not support editor commands;
   * `VALIDATION_FAILED` on an unsupported/ambiguous mapping or a schema
   * violation (the refusal reason is the message, verbatim — never source
   * text or a stack); `RENDER_FAILED` / `TIMEOUT` on an engine failure.
   */
  verifyEditorCommand(projectId: string, request: EditorVerifyRequest): Promise<EditorProofResponse>;
}
