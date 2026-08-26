// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — ScadForge Issue #13.
//
// `packages/protocol/**` is Tech-Lead-owned now that Issue #13 has merged
// (CLAUDE.md hard rule 2 / PROJECT_CONTEXT.md "Contract freeze rule"). Do NOT
// edit anything in this package inside a feature PR. Changes require a
// Tech-Lead-approved contract-change issue, merged separately.
//
// SPDX-License-Identifier: Apache-2.0
// ─────────────────────────────────────────────────────────────────────────────
//
// @scadforge/protocol — the transport contract: SSE events, REST shapes, the
// `.scadforge/` on-disk model, and the shared error vocabulary.
//
// ZERO runtime dependencies, by contract. This package sits at the bottom of
// the dependency graph; the only legal directions are scad-core → protocol and
// agent → {protocol, scad-core}. It must never import from another workspace
// package.
// ─────────────────────────────────────────────────────────────────────────────

export const PROTOCOL_PACKAGE_NAME = "@scadforge/protocol";

export type { JsonPrimitive, JsonValue, JsonObject, ViewName, ExportFormat, ParamValue, ParamValues, ToolName, ValidationBadge } from "./vocabulary.js";
export { VIEW_NAMES, EXPORT_FORMATS, TOOL_NAMES, MCP_TOOL_NAME_PREFIX } from "./vocabulary.js";

export type { ScadForgeErrorCode, ApiError } from "./errors.js";
export { ERROR_CODES, HTTP_STATUS_BY_ERROR_CODE } from "./errors.js";

export type {
  SnapshotId,
  SnapshotOrigin,
  SnapshotFiles,
  RenderRef,
  ValidationSummary,
  AnnotationRef,
  SnapshotManifest,
  ExportRecord,
  ProviderConfig,
  ProjectManifest
} from "./snapshot.js";
export { PROJECT_LAYOUT, SNAPSHOT_ID_PAD_WIDTH } from "./snapshot.js";

export type {
  SseEventType,
  TurnStartedEvent,
  ToolCallEvent,
  ToolArtifact,
  ToolResultEvent,
  AssistantTextEvent,
  SnapshotCreatedEvent,
  TurnStatus,
  ModelUsage,
  PassUsage,
  TurnUsage,
  TurnDoneEvent,
  ErrorEvent,
  SseEvent,
  SseEventOf
} from "./events.js";
export { SSE_EVENT_TYPES, SSE_CONTENT_TYPE } from "./events.js";

export type {
  ApiResponse,
  HealthResponse,
  CreateProjectRequest,
  ProjectResponse,
  ListProjectsResponse,
  ChatImageInput,
  ChatTurnRequest,
  ListSnapshotsResponse,
  SnapshotResponse,
  SnapshotDiffResponse,
  RevertRequest,
  ParamDefinitionWire,
  ParamsResponse,
  ParamsUpdateRequest,
  RenderViewsRequest,
  RenderedViewResponse,
  RenderViewsResponse,
  ExportRequest,
  ExportResponse
} from "./api.js";
export { API_BASE_PATH, API_ROUTES } from "./api.js";
