// SPDX-License-Identifier: Apache-2.0
//
// The `ModelProvider` seam (SDP §6.4, amended by Spike 3 §6).
//
// Deliberately free of Claude-Code concepts. The SDK spawns a bundled `cli.js`
// child process and needs `settingSources`, `tools`, `permissionMode`,
// `allowDangerouslySkipPermissions` and `includePartialMessages` — every one of
// them mandatory, and every one of them a silent cost or isolation regression
// when wrong. They live INSIDE `ClaudeAgentSdkProvider` and never appear here,
// so a future in-process `VercelAiSdkProvider` can slot in unchanged.

import type { SseEvent, TurnStatus, TurnUsage } from "@scadforge/protocol";
import type { PassBudget } from "../tools/pass-budget.js";
import type { ToolActivityRecorder } from "../tools/activity.js";
import type { ToolHandlerMap } from "../tools/handlers.js";

/** Everything the provider needs to run one user turn. */
export interface TurnInput {
  turnId: string;
  projectId: string;
  /** The user-turn prompt (see `buildTurnPrompt`). */
  prompt: string;
  /** The system prompt (see `buildSystemPrompt`). */
  systemPrompt: string;
  /**
   * Requested model id. ADVISORY only: Spike 3 §2.5 found the SDK bills an
   * auxiliary `claude-haiku-4-5` call regardless, so this does not guarantee
   * single-model execution.
   */
  model?: string | null;
  /** Cancels the turn; maps to a client disconnect on the SSE route. */
  signal?: AbortSignal;
}

/**
 * The tool surface handed to a provider: the handlers plus the two pieces of
 * turn state the provider must read to stamp events and bucket usage.
 */
export interface AgentToolSet {
  handlers: ToolHandlerMap;
  budget: PassBudget;
  activity: ToolActivityRecorder;
}

/**
 * What one turn produced.
 *
 * Spike 3 §6 amendment 2: a scalar `tokensUsed` would be a lie, so usage is
 * carried per pass AND per model (`@scadforge/protocol`'s `TurnUsage`).
 */
export interface TurnResult {
  status: TurnStatus;
  /** The agent's short hand-back. Already stripped of fenced blocks. */
  summary: string | null;
  /** `write_scad` calls accepted this turn. */
  passesUsed: number;
  /** null when accounting was unavailable (e.g. an aborted turn). */
  usage: TurnUsage | null;
  durationMs: number;
}

/** Sink for the frozen SSE event union. */
export type AgentEventSink = (event: SseEvent) => void;

/** The model backend seam. v1 ships exactly one implementation. */
export interface ModelProvider {
  /** Stable id, persisted in `.scadforge/project.json` as `provider.provider`. */
  readonly id: string;
  runTurn(input: TurnInput, tools: AgentToolSet, onEvent: AgentEventSink): Promise<TurnResult>;
}
