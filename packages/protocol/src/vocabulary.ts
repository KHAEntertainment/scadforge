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
// Shared wire vocabulary for `@scadforge/protocol`.
//
// ── MIRROR NOTICE ────────────────────────────────────────────────────────────
// `ViewName`, `ExportFormat`, `ParamValue` and `ToolName` are *canonically*
// defined elsewhere:
//   - ViewName / ExportFormat / ParamValue → packages/scad-core/src/types.ts
//   - ToolName                             → packages/agent/src/tools/contract.ts
//
// `@scadforge/protocol` has ZERO dependencies by contract (Issue #13 AC) and
// sits at the bottom of the dependency graph — the only legal directions are
// scad-core → protocol and agent → {protocol, scad-core}. Protocol therefore
// cannot import those definitions and re-declares them here instead.
//
// Drift is guarded by compile-time *and* runtime assertions in:
//   - packages/scad-core/src/types.test.ts   (ViewName, ExportFormat, ParamValue)
//   - packages/agent/src/tools/contract.test.ts (ToolName)
// Those tests fail CI if either side changes without the other.
// ─────────────────────────────────────────────────────────────────────────────

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** Any value that survives a `JSON.parse(JSON.stringify(x))` round trip. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object (the shape every SSE frame body and REST body takes). */
export type JsonObject = { [key: string]: JsonValue };

/**
 * The fixed render view set (SDP §6.2, camera constants frozen in
 * `packages/scad-core/src/types.ts`). MIRROR — see notice above.
 */
export const VIEW_NAMES = ["iso", "front", "top", "right", "section"] as const;

/** One of the five fixed views. MIRROR of scad-core's `ViewName`. */
export type ViewName = (typeof VIEW_NAMES)[number];

/**
 * Mesh export formats offered by the `export` tool / REST export route.
 * MIRROR — see notice above.
 */
export const EXPORT_FORMATS = ["3mf", "stl", "off"] as const;

/** MIRROR of scad-core's `ExportFormat`. */
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * A single Customizer parameter value as it travels over the wire.
 * MIRROR of scad-core's `ParamValue`.
 */
export type ParamValue = number | string | boolean | number[] | string[] | boolean[];

/** A `{name: value}` bag of Customizer parameter values. */
export type ParamValues = Record<string, ParamValue>;

/**
 * The seven agent tools, shared between the Claude Agent SDK provider and
 * `packages/mcp-server` (PROJECT_CONTEXT.md "Agent tools"). MIRROR — see notice
 * above. Order is load-bearing only for readability, not for the contract.
 */
export const TOOL_NAMES = [
  "read_project",
  "write_scad",
  "set_params",
  "render_views",
  "validate_mesh",
  "export",
  "library_lookup"
] as const;

/** MIRROR of agent's `ToolName`. */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The prefix the Claude Agent SDK exposes MCP tools under
 * (`mcp__<serverName>__<toolName>`). Spike 3 §6: this prefix is a Claude-Code
 * artifact — it is stripped at the provider boundary and must NEVER appear in
 * a `tool_call` / `tool_result` SSE event's `name` field.
 */
export const MCP_TOOL_NAME_PREFIX = "mcp__scadforge__";

/**
 * Traffic-light validation state shown in the UI status strip (SDP §9).
 * - `green`: all hard gates pass.
 * - `amber`: hard gates pass but warnings exist (e.g. multi-part allowed by
 *   override, nonzero genus).
 * - `red`: at least one hard gate failed; `export` refuses without an explicit
 *   override (CLAUDE.md hard rule 7).
 */
export type ValidationBadge = "green" | "amber" | "red";
