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
// The SSE event union streamed from `POST /api/projects/:id/chat`
// (PROJECT_CONTEXT.md "SSE event union").
//
// Framing: each frame is `event: <type>\ndata: <JSON of the event object>\n\n`.
// The `type` field is repeated inside the JSON body so a client that reads only
// `data` still has the discriminant.
//
// SIZE RULE (Spike 3 §6): SSE frames NEVER carry base64 image data. Renders are
// referenced by URL/path via `ToolArtifact`; the image blocks that reach the
// model are a provider-side tool *return value*, not an event.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadForgeErrorCode } from "./errors.js";
import type { SnapshotManifest } from "./snapshot.js";
import type { ToolName, ViewName } from "./vocabulary.js";

/** Every member of the SSE event union. */
export const SSE_EVENT_TYPES = [
  "turn_started",
  "tool_call",
  "tool_result",
  "snapshot_created",
  "assistant_text",
  "turn_done",
  "error"
] as const;

/** The `event:` field of an SSE frame, and the `type` discriminant of its body. */
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** Content type the chat SSE route must respond with. */
export const SSE_CONTENT_TYPE = "text/event-stream";

/** Opens a turn. Exactly one per `POST .../chat` request that reaches the agent. */
export interface TurnStartedEvent {
  type: "turn_started";
  /** Server-generated, unique per turn; every later event in this turn repeats it. */
  turn_id: string;
  project_id: string;
  /** The pass budget in force for this turn (`SCADFORGE_MAX_PASSES`, default 2). */
  max_passes: number;
  /** ISO-8601 UTC. */
  started_at: string;
}

/** The agent invoked a tool. */
export interface ToolCallEvent {
  type: "tool_call";
  turn_id: string;
  /** Correlates with the matching {@link ToolResultEvent}. */
  tool_call_id: string;
  /**
   * UNPREFIXED tool name. Spike 3 §6: the SDK addresses tools as
   * `mcp__scadforge__<name>`; the prefix is stripped at the provider boundary
   * and must never appear here.
   */
  name: ToolName;
  /** Which self-correction pass this call belongs to. 0 = the initial plan pass. */
  pass: number;
  /**
   * Short, UI-safe description of the input (e.g. `"iso, front, right, section"`).
   * NEVER the full `.scad` source — CLAUDE.md hard rule 5.
   */
  input_summary: string | null;
}

/** A render, export, mesh or snapshot artifact a tool produced. */
export interface ToolArtifact {
  kind: "render" | "export" | "mesh" | "snapshot";
  /** Present only for `kind: "render"`. */
  view: ViewName | null;
  /** HTTP path the UI fetches this artifact from. NEVER base64 data. */
  url: string;
  bytes: number | null;
}

/** A tool returned. Mirrors the tool's JSON envelope (Spike 3 §7.1). */
export interface ToolResultEvent {
  type: "tool_result";
  turn_id: string;
  tool_call_id: string;
  name: ToolName;
  pass: number;
  /** The envelope's `ok`. */
  ok: boolean;
  /** The envelope's `error_code`; null on success. */
  error_code: ScadForgeErrorCode | null;
  /** Short human-readable outcome for the chat transcript. */
  summary: string | null;
  /** References to files the tool produced. Empty array when it produced none. */
  artifacts: ToolArtifact[];
  duration_ms: number | null;
}

/**
 * A chunk of assistant prose.
 *
 * HOST-ENFORCED (Spike 3 §4.2, CLAUDE.md hard rule 5): fenced code blocks are
 * stripped from `text` before this event is emitted. Prompt-level instruction
 * is not sufficient — models paste `.scad` under pressure.
 */
export interface AssistantTextEvent {
  type: "assistant_text";
  turn_id: string;
  text: string;
}

/**
 * A snapshot was written to `.scadforge/history/`.
 *
 * Spike 3 §6: this has no Claude Agent SDK equivalent. Because tool handlers
 * run in-process, the provider emits it directly from the `write_scad` handler.
 */
export interface SnapshotCreatedEvent {
  type: "snapshot_created";
  /** null for a manual save made outside an agent turn. */
  turn_id: string | null;
  project_id: string;
  snapshot: SnapshotManifest;
}

/** How a turn ended. */
export type TurnStatus =
  /** The agent finished and handed back a summary. */
  | "completed"
  /** Cancelled — client disconnect or `Query.interrupt()`. */
  | "aborted"
  /** The pass budget ran out before validation went green. */
  | "pass_budget_exhausted"
  /** The provider or a tool failed unrecoverably; an `error` event precedes this. */
  | "error";

/**
 * Token counts for one model. Spike 3 §2.4: these come ONLY from
 * `stream_event` → `message_delta`. `SDKAssistantMessage.message.usage` is a
 * `message_start` placeholder and must never be summed.
 */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Per-pass accounting. */
export interface PassUsage extends ModelUsage {
  pass: number;
  duration_ms: number;
  tool_calls: number;
  /** Image blocks returned to the model during this pass. */
  images: number;
}

/**
 * Turn accounting. A scalar `tokens_used` would be a lie: Spike 3 §2.5 showed
 * the SDK always bills an auxiliary `claude-haiku-4-5` call (~900 input tokens)
 * on top of the selected model, so cost must be attributed per model.
 */
export interface TurnUsage {
  per_pass: PassUsage[];
  /** Keyed by model id, e.g. `claude-haiku-4-5`. */
  by_model: Record<string, ModelUsage>;
  /** List-price USD as reported by the provider. */
  cost_usd: number;
}

/** Closes a turn. Exactly one per turn, and always the last event. */
export interface TurnDoneEvent {
  type: "turn_done";
  turn_id: string;
  status: TurnStatus;
  /** Number of `write_scad` calls that succeeded in this turn. */
  passes_used: number;
  /** The agent's short hand-back summary. Never contains fenced `.scad`. */
  summary: string | null;
  /** null when accounting was unavailable (e.g. an aborted turn). */
  usage: TurnUsage | null;
  duration_ms: number;
}

/**
 * A failure. May be followed by a `turn_done` with `status: "error"`; a failure
 * that occurs before a turn opens carries `turn_id: null`.
 */
export interface ErrorEvent {
  type: "error";
  turn_id: string | null;
  error_code: ScadForgeErrorCode;
  message: string;
}

/** The frozen SSE event union (PROJECT_CONTEXT.md). */
export type SseEvent =
  | TurnStartedEvent
  | ToolCallEvent
  | ToolResultEvent
  | SnapshotCreatedEvent
  | AssistantTextEvent
  | TurnDoneEvent
  | ErrorEvent;

/** Narrows {@link SseEvent} to one member by its `type`. */
export type SseEventOf<T extends SseEventType> = Extract<SseEvent, { type: T }>;
