// SPDX-License-Identifier: Apache-2.0
//
// Turn orchestration: the write -> render -> validate -> fix loop.
//
// This is the one entry point `apps/server`'s chat route calls. It owns the
// turn's lifecycle events (`turn_started` / `turn_done` / `error`), wires the
// pass budget and the tool handlers together, and hands the whole thing to a
// `ModelProvider`. The iteration itself is the MODEL's, driven by the system
// prompt; what this file guarantees is that the turn is bounded
// (`SCADFORGE_MAX_PASSES`), stops early on green validation, and always closes
// with exactly one `turn_done`.

import type { SseEvent, TurnStatus } from "@scadforge/protocol";
import { buildSystemPrompt } from "./prompts/system.js";
import { buildTurnPrompt } from "./prompts/turn.js";
import { ToolActivityRecorder } from "./tools/activity.js";
import { createToolHandlers } from "./tools/handlers.js";
import { PassBudget, resolveMaxPasses } from "./tools/pass-budget.js";
import type { LibraryIndexApi, ScadCoreApi } from "./tools/scad-core-api.js";
import type { AgentEventSink, ModelProvider, TurnResult } from "./provider/types.js";
import { sanitizeChatText } from "./sanitize.js";

/** Options for {@link runAgentTurn}. */
export interface RunAgentTurnOptions {
  projectId: string;
  /** The user's message, verbatim. */
  message: string;
  provider: ModelProvider;
  scadCore: ScadCoreApi;
  libraries: LibraryIndexApi;
  onEvent: AgentEventSink;

  /** Server-generated. Defaults to a random UUID. */
  turnId?: string;
  /** Defaults to `SCADFORGE_MAX_PASSES`, then to 2. */
  maxPasses?: number;
  /** Environment bag `SCADFORGE_MAX_PASSES` is read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** True when the project already has a `model.scad` worth reading first. */
  hasExistingModel?: boolean;
  /** True when `packages/libs` is wired and `library_lookup` will answer. */
  librariesAvailable?: boolean;
  /** Advisory model id. */
  model?: string | null;
  /** Cancels the turn (client disconnect). */
  signal?: AbortSignal;
  /** Overrides the built system prompt entirely. */
  systemPrompt?: string;
  /** Extra project-specific guidance appended to the built system prompt. */
  additionalGuidance?: string;
  /** Disable the "stop as soon as validation is green" rule. Default false. */
  allowWritesAfterGreenValidation?: boolean;
}

/** What one turn produced, plus the identity the caller needs to correlate it. */
export interface AgentTurnOutcome extends TurnResult {
  turnId: string;
  maxPasses: number;
}

function newTurnId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Run one user turn end to end.
 *
 * Always emits exactly one `turn_started` and exactly one `turn_done`, with
 * `turn_done` last — including on a rejected prompt or a provider crash, so an
 * SSE client can close on it unconditionally.
 */
export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnOutcome> {
  const turnId = options.turnId ?? newTurnId();
  const maxPasses = options.maxPasses ?? resolveMaxPasses(options.env);
  const startedAt = Date.now();
  const events: AgentEventSink = (event: SseEvent) => options.onEvent(event);

  const message = options.message?.trim() ?? "";

  events({
    type: "turn_started",
    turn_id: turnId,
    project_id: options.projectId,
    max_passes: maxPasses,
    started_at: new Date(startedAt).toISOString()
  });

  const finish = (status: TurnStatus, result: Partial<TurnResult> = {}): AgentTurnOutcome => {
    const outcome: AgentTurnOutcome = {
      turnId,
      maxPasses,
      status,
      summary: result.summary ?? null,
      passesUsed: result.passesUsed ?? 0,
      usage: result.usage ?? null,
      durationMs: result.durationMs ?? Date.now() - startedAt
    };
    events({
      type: "turn_done",
      turn_id: turnId,
      status: outcome.status,
      passes_used: outcome.passesUsed,
      summary: outcome.summary,
      usage: outcome.usage,
      duration_ms: outcome.durationMs
    });
    return outcome;
  };

  if (!message) {
    events({
      type: "error",
      turn_id: turnId,
      error_code: "INVALID_REQUEST",
      message: "The turn message is empty. Describe the part you want, or the change you want made."
    });
    return finish("error");
  }

  const budget = new PassBudget({
    maxPasses,
    stopOnGreenValidation: options.allowWritesAfterGreenValidation !== true
  });
  const activity = new ToolActivityRecorder();
  const handlers = createToolHandlers({
    scadCore: options.scadCore,
    libraries: options.libraries,
    budget,
    activity,
    turnId,
    projectId: options.projectId,
    emit: events
  });

  const systemPrompt =
    options.systemPrompt ??
    buildSystemPrompt({
      maxPasses,
      librariesAvailable: options.librariesAvailable,
      additionalGuidance: options.additionalGuidance
    });

  try {
    const result = await options.provider.runTurn(
      {
        turnId,
        projectId: options.projectId,
        prompt: buildTurnPrompt({ message, hasExistingModel: options.hasExistingModel }),
        systemPrompt,
        model: options.model,
        signal: options.signal
      },
      { handlers, budget, activity },
      events
    );
    return finish(result.status, {
      ...result,
      summary: result.summary ? sanitizeChatText(result.summary) : null,
      passesUsed: result.passesUsed
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const aborted = (error instanceof Error && error.name === "AbortError") || options.signal?.aborted === true;
    events({
      type: "error",
      turn_id: turnId,
      error_code: aborted ? "TURN_ABORTED" : "AGENT_ERROR",
      message: text
    });
    return finish(aborted ? "aborted" : "error", { passesUsed: budget.pass });
  }
}
