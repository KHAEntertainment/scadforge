// SPDX-License-Identifier: Apache-2.0
//
// The CAD + library seams.
//
// `packages/agent` must be runnable — and unit-testable — without OpenSCAD,
// without Docker and without `packages/libs`. The tool handlers therefore talk
// to two narrow interfaces declared HERE, phrased entirely in the frozen
// vocabulary of `packages/scad-core/src/types.ts`. `apps/server` (Issue #17)
// binds the real implementations; the tests in this package bind the mocks in
// `src/testing/`.
//
// Deliberately type-only imports: nothing in this package imports a scad-core
// *implementation* module (Issue #14 owns those).

import type {
  ExportFormat,
  ExportRunResult,
  LibraryName,
  LibrarySymbol,
  ParamSchema,
  ParamValues,
  RenderResult,
  SyntaxCheckResult,
  ValidationReport,
  ValidationResult,
  ViewName
} from "@scadforge/scad-core";
import type { SnapshotManifest, ToolArtifact } from "@scadforge/protocol";

/** What `read_project` needs from the project store. */
export interface ProjectState {
  /** Current `model.scad` contents. */
  scad: string;
  /** Current `params.json` values, already converted to `ParamValue`s. */
  params: ParamValues;
  /** The Customizer schema from `--export-format=param`. */
  param_schema: ParamSchema;
  /** The most recent `ValidationReport`, or null if never validated. */
  validation: ValidationReport | null;
  /** Id of the head snapshot, or null for a project with no history. */
  head_snapshot: string | null;
}

/** Input to {@link ScadCoreApi.writeScad}. */
export interface WriteScadRequest {
  /** Complete new `model.scad` contents. Whole-file writes only in v1. */
  content: string;
  /** One-line snapshot message. Already sanitized by the handler. */
  message: string;
  /** The self-correction pass this write belongs to, for the snapshot manifest. */
  pass: number;
}

/** Result of {@link ScadCoreApi.writeScad}. */
export interface WriteScadOutcome {
  /** Bytes written (UTF-8). */
  bytes: number;
  syntax_check: SyntaxCheckResult;
  /** The snapshot this write created, or null when no snapshot was taken. */
  snapshot: SnapshotManifest | null;
}

/** Result of {@link ScadCoreApi.setParams}. */
export interface SetParamsOutcome {
  /** The full parameter bag after the update — only ACCEPTED values are applied. */
  params: ParamValues;
  /**
   * Names whose supplied value was rejected and therefore NOT applied: not
   * declared in the current Customizer schema, of the wrong runtime type, or
   * out of its declared min/max/options/maxLength (Issue #32). The frozen
   * `set_params` tool result has no separate error field for the latter two
   * cases, so every rejection reason folds into this one array — never a
   * silent coerce of a bad value into range.
   */
  unknown_params: string[];
  snapshot: SnapshotManifest | null;
}

/** Agent-level render request — the tool input, with project paths already bound. */
export interface AgentRenderRequest {
  views?: readonly ViewName[];
  imgsize?: readonly [number, number];
  params?: ParamValues;
}

/** Agent-level validation request. */
export interface AgentValidateRequest {
  params?: ParamValues;
  allowMultiPart?: boolean;
}

/** Agent-level export request. */
export interface AgentExportRequest {
  format: ExportFormat;
  params?: ParamValues;
  allowValidationFailure?: boolean;
}

/**
 * Everything the seven tool handlers need from the CAD layer.
 *
 * Every method may reject; handlers translate a rejection into a non-error tool
 * result carrying `{ok:false, error_code, message}` (see `TOOL_RESULT_RULES`).
 * Implementations are expected to wrap subprocess and filesystem work in a
 * timeout and reject with a {@link ScadCoreFailure} carrying `TIMEOUT`.
 */
export interface ScadCoreApi {
  readProject(): Promise<ProjectState>;
  writeScad(request: WriteScadRequest): Promise<WriteScadOutcome>;
  setParams(params: ParamValues, pass: number): Promise<SetParamsOutcome>;
  renderViews(request: AgentRenderRequest): Promise<RenderResult>;
  validateMesh(request: AgentValidateRequest): Promise<ValidationResult>;
  exportModel(request: AgentExportRequest): Promise<ExportRunResult>;

  /**
   * Read a rendered PNG as BARE base64 (no `data:` URI prefix) for the image
   * blocks `render_views` returns to the model.
   */
  readImageBase64(absolutePath: string): Promise<string>;

  /**
   * HTTP path the UI fetches an artifact from, for `ToolArtifact.url`. Return
   * null when the artifact is not servable. SSE frames never carry base64.
   *
   * `ref` is the artifact's absolute path for `render`/`export`/`mesh`, and the
   * snapshot id for `snapshot`.
   */
  artifactUrl(kind: ToolArtifact["kind"], ref: string): string | null;

  /**
   * An exported file's path relative to `.scadforge/exports/` — the value
   * `exportResultSchema.file` promises the model.
   */
  exportFileName(absolutePath: string): string;
}

/** The BOSL2/MCAD lookup seam (`packages/libs`, Issue #19). */
export interface LibraryIndexApi {
  lookup(request: { query: string; library?: LibraryName; limit?: number }): Promise<LibrarySymbol[]>;
}

/**
 * The error shape a {@link ScadCoreApi} implementation should reject with so a
 * handler can pass the code straight through instead of flattening everything
 * to `INTERNAL_ERROR`.
 */
export interface ScadCoreFailure extends Error {
  error_code?: string;
}
