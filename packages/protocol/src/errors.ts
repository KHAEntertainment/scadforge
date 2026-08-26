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
// The single error vocabulary for ScadForge.
//
// PROJECT_CONTEXT.md fixes the REST error format as `{error_code, message}`.
// Spike 3 §7.1 established that agent tool failures use the SAME shape inside
// their JSON result envelope (`{ok:false, error_code, message}`), so a code
// flows tool → SSE `error` event → HTTP response with no translation layer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every error code the system may emit. CLOSED union by design: a frozen
 * contract means adding a code is a Tech-Lead-approved contract change, not a
 * unilateral edit inside a feature PR.
 *
 * Codes marked (tool) were exercised or explicitly called for by Spike 3 §7.1.
 */
export const ERROR_CODES = [
  /** Malformed request body / query, failed schema validation. */
  "INVALID_REQUEST",
  /** Generic 404 for a route-level resource with no more specific code. */
  "NOT_FOUND",
  /** The requested project directory does not exist or is not a ScadForge project. */
  "PROJECT_NOT_FOUND",
  /** The requested `.scadforge/history/NNNN` snapshot does not exist. */
  "SNAPSHOT_NOT_FOUND",
  /** Write conflicted with concurrent state (e.g. snapshot id already taken). */
  "CONFLICT",
  /** (tool) OpenSCAD rejected the `.scad` source — `write_scad` syntax check failed. */
  "SYNTAX_ERROR",
  /** (tool) An OpenSCAD render invocation failed or produced no image. */
  "RENDER_FAILED",
  /** (tool) A mesh export invocation failed or produced no file. */
  "EXPORT_FAILED",
  /** (tool) The exported mesh could not be parsed/loaded for validation. */
  "MESH_PARSE_FAILED",
  /** Validation hard gates failed and no override was supplied (CLAUDE.md rule 7). */
  "VALIDATION_FAILED",
  /** (tool) `write_scad` refused because the per-turn pass budget is spent. */
  "PASS_BUDGET_EXHAUSTED",
  /** (tool) An external call (OpenSCAD subprocess, filesystem) exceeded its timeout. */
  "TIMEOUT",
  /** The requested export format is not supported by the pinned toolchain. */
  "UNSUPPORTED_FORMAT",
  /** The BOSL2/MCAD lookup index is missing or unreadable. */
  "LIBRARY_UNAVAILABLE",
  /** The model provider failed (SDK error, auth failure, upstream API error). */
  "AGENT_ERROR",
  /** The turn was cancelled — client disconnected, or `Query.interrupt()` fired. */
  "TURN_ABORTED",
  /** Unclassified server-side failure. */
  "INTERNAL_ERROR"
] as const;

/** One of {@link ERROR_CODES}. `SCREAMING_SNAKE_CASE` (Spike 3 §7.1). */
export type ScadForgeErrorCode = (typeof ERROR_CODES)[number];

/**
 * The one and only error body. Returned by every REST route on failure
 * (PROJECT_CONTEXT.md "API spec") and carried by the SSE `error` event.
 *
 * `message` is human-readable and actionable; it is shown to the user and read
 * by the agent, so it must never contain a stack trace or a full `.scad` file.
 */
export interface ApiError {
  error_code: ScadForgeErrorCode;
  message: string;
}

/**
 * The HTTP status each error code maps to, so `apps/server` route handlers do
 * not each invent their own mapping. Route layer only — SSE frames and tool
 * results carry the code alone.
 */
export const HTTP_STATUS_BY_ERROR_CODE = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  SNAPSHOT_NOT_FOUND: 404,
  CONFLICT: 409,
  SYNTAX_ERROR: 422,
  RENDER_FAILED: 500,
  EXPORT_FAILED: 500,
  MESH_PARSE_FAILED: 500,
  VALIDATION_FAILED: 422,
  PASS_BUDGET_EXHAUSTED: 429,
  TIMEOUT: 504,
  UNSUPPORTED_FORMAT: 400,
  LIBRARY_UNAVAILABLE: 503,
  AGENT_ERROR: 502,
  TURN_ABORTED: 499,
  INTERNAL_ERROR: 500
} as const satisfies Record<ScadForgeErrorCode, number>;
