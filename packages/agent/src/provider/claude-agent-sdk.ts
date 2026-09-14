// SPDX-License-Identifier: Apache-2.0
//
// `ClaudeAgentSdkProvider` — the v1 `ModelProvider`.
//
// Every Claude-Code-specific option is set HERE and is never a caller's
// responsibility (Spike 3 §6 amendment 1): getting `settingSources` or `tools`
// wrong is a silent 200x cost regression, not a style question.
//
//   settingSources: []              omitting it does NOT isolate — the host's
//                                   ~/.claude settings, CLAUDE.md, skills and
//                                   plugin catalogs load (~50,500 extra input
//                                   tokens, ~$0.50 per cold run)
//   tools: []                       disables every built-in tool, so the MCP
//                                   server is the agent's whole action surface
//                                   AND the seven schemas stay resident instead
//                                   of deferring behind ToolSearch
//   includePartialMessages: true    the ONLY way to get real usage: it comes
//                                   from `message_delta` stream events;
//                                   `SDKAssistantMessage.message.usage` is a
//                                   `message_start` placeholder
//   permissionMode / allowDangerouslySkipPermissions
//                                   in-process handlers, no interactive host
//   strictMcpConfig: true           without it, the bundled CLI loads the
//                                   OPERATOR's entire ~/.claude.json MCP
//                                   server list on top of the `scadforge`
//                                   server built below -- `settingSources: []`
//                                   does NOT cover this. Issue #75: measured
//                                   at 12 attempted `claude.ai …` connectors,
//                                   ~280 held connections and 157K
//                                   cache-creation tokens (~$1.57) for their
//                                   tool schemas on a single trivial turn
//
// The SDK is reached through a small injectable {@link ClaudeAgentSdkBinding}
// so the unit tests exercise the whole message loop with zero live API calls.

import type { ModelUsage, ScadForgeErrorCode, SseEvent, TurnStatus, TurnUsage } from "@scadforge/protocol";
import {
  MCP_SERVER_NAME,
  MCP_TOOL_NAME_PREFIX,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SHAPES,
  TOOL_NAMES,
  type ToolName
} from "../tools/contract.js";
import { sanitizeChatText } from "../sanitize.js";
import type { AgentEventSink, AgentToolSet, ModelProvider, TurnInput, TurnResult } from "./types.js";

/** The EXACT pinned SDK version (PROJECT_CONTEXT.md Spike Decisions). */
export const CLAUDE_AGENT_SDK_VERSION = "0.3.246";

/** Provider id persisted in `.scadforge/project.json`. */
export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-agent-sdk";

/**
 * The three SDK entry points this provider uses. Injectable so tests can drive
 * the full message loop without spawning the bundled CLI or calling the API.
 */
export interface ClaudeAgentSdkBinding {
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: any, extra: unknown) => Promise<any>
  ): any;
  createSdkMcpServer(options: { name: string; version?: string; tools: any[] }): any;
  query(params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<any> & {
    interrupt?: () => Promise<unknown>;
  };
}

/**
 * Options this provider forces on every `query()`. Exported so an
 * options-inspection test can assert them without reaching into private state.
 */
export const MANDATORY_SDK_OPTIONS = {
  settingSources: [] as string[],
  tools: [] as string[],
  includePartialMessages: true,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  strictMcpConfig: true
} as const;

/** Default cap on SDK round trips. NOT the pass budget — that lives in the tools. */
export const DEFAULT_MAX_TURNS = 40;

/** Construction options. */
export interface ClaudeAgentSdkProviderOptions {
  /** Defaults to a lazy `import("@anthropic-ai/claude-agent-sdk")`. */
  binding?: ClaudeAgentSdkBinding;
  /** Default model id when a turn does not name one. */
  model?: string | null;
  /** SDK round-trip cap. See {@link DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
  /**
   * Receives the CLI's stderr; off by default. Called with the RUNNING
   * turn's id alongside each chunk (Issue #75 QA fix 2): the provider
   * instance is shared across turns (`agent-impl.ts` constructs one for the
   * server's lifetime), so per-turn labelling cannot live in shared state on
   * this class -- `buildQuery` closes over `input.turnId` per call instead.
   */
  onStderr?: (data: string, turnId: string) => void;
}

/** The prompt + options actually handed to `query()`. */
export interface BuiltQuery {
  prompt: string;
  options: Record<string, unknown>;
}

function emptyModelUsage(): ModelUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  };
}

/** One pass's accumulating token bucket. */
interface PassBucket {
  pass: number;
  started: number;
  ended: number;
  usage: ModelUsage;
}

/** Strip the `mcp__scadforge__` prefix the SDK addresses MCP tools by. */
export function unprefixToolName(name: string): ToolName | null {
  const bare = name.startsWith(MCP_TOOL_NAME_PREFIX) ? name.slice(MCP_TOOL_NAME_PREFIX.length) : name;
  return (TOOL_NAMES as readonly string[]).includes(bare) ? (bare as ToolName) : null;
}

/** Short, UI-safe description of a tool input. NEVER the `.scad` source. */
export function summarizeToolInput(name: ToolName, input: unknown): string | null {
  const bag = (input ?? {}) as Record<string, any>;
  switch (name) {
    case "read_project":
      return null;
    case "write_scad":
      return sanitizeChatText(String(bag.message ?? ""), 120) || null;
    case "set_params": {
      const names = Object.keys(bag.params ?? {});
      return names.length ? names.join(", ") : null;
    }
    case "render_views":
      return Array.isArray(bag.views) && bag.views.length ? bag.views.join(", ") : "default views";
    case "validate_mesh":
      return bag.allowMultiPart ? "allowMultiPart" : null;
    case "export":
      return bag.format ? String(bag.format) : null;
    case "library_lookup":
      return sanitizeChatText(String(bag.query ?? ""), 80) || null;
  }
}

/** Best-effort outcome summary parsed from a tool-result block. */
function parseResultBlock(content: unknown): { ok: boolean | null; error_code: ScadForgeErrorCode | null } {
  const blocks = Array.isArray(content) ? content : [];
  // `TOOL_RESULT_RULES.contentMayBeArrayOrString`: the SDK collapses an error
  // result's content to a plain string.
  const text =
    typeof content === "string" ? content : (blocks.find((b: any) => b?.type === "text")?.text ?? "");
  try {
    const parsed = JSON.parse(text);
    return {
      ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
      error_code: typeof parsed.error_code === "string" ? (parsed.error_code as ScadForgeErrorCode) : null
    };
  } catch {
    return { ok: null, error_code: null };
  }
}

/** The v1 provider. */
export class ClaudeAgentSdkProvider implements ModelProvider {
  readonly id = CLAUDE_AGENT_SDK_PROVIDER_ID;

  private readonly injectedBinding?: ClaudeAgentSdkBinding;
  private readonly model: string | null;
  private readonly maxTurns: number;
  private readonly onStderr?: (data: string, turnId: string) => void;

  constructor(options: ClaudeAgentSdkProviderOptions = {}) {
    this.injectedBinding = options.binding;
    this.model = options.model ?? null;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.onStderr = options.onStderr;
  }

  /** Resolve the SDK, lazily, so importing this module costs nothing. */
  async binding(): Promise<ClaudeAgentSdkBinding> {
    if (this.injectedBinding) return this.injectedBinding;
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return {
      tool: sdk.tool as unknown as ClaudeAgentSdkBinding["tool"],
      createSdkMcpServer: sdk.createSdkMcpServer as unknown as ClaudeAgentSdkBinding["createSdkMcpServer"],
      query: sdk.query as unknown as ClaudeAgentSdkBinding["query"]
    };
  }

  /**
   * Build the exact `query()` arguments for a turn.
   *
   * Exposed (and tested) on its own: the mandatory options above are the whole
   * reason this seam exists, so they must be assertable without a live run.
   */
  buildQuery(binding: ClaudeAgentSdkBinding, input: TurnInput, tools: AgentToolSet): BuiltQuery {
    const definitions = TOOL_NAMES.map((name) =>
      binding.tool(
        name,
        TOOL_DESCRIPTIONS[name],
        TOOL_INPUT_SHAPES[name] as unknown as Record<string, unknown>,
        async (args: any) => tools.handlers[name](args)
      )
    );

    const server = binding.createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: "1.0.0",
      tools: definitions
    });

    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const options: Record<string, unknown> = {
      systemPrompt: input.systemPrompt,
      mcpServers: { [MCP_SERVER_NAME]: server },
      allowedTools: TOOL_NAMES.map((name) => `${MCP_TOOL_NAME_PREFIX}${name}`),
      maxTurns: this.maxTurns,
      abortController: controller,
      ...MANDATORY_SDK_OPTIONS
    };
    const model = input.model ?? this.model;
    if (model) options.model = model;
    // Bind THIS turn's id here, per `query()` call -- `this.onStderr` is one
    // function shared across every turn this (long-lived) provider instance
    // ever runs, so the turn id cannot be read off `this` at call time.
    if (this.onStderr) {
      const onStderr = this.onStderr;
      const turnId = input.turnId;
      options.stderr = (data: string) => onStderr(data, turnId);
    }

    return { prompt: input.prompt, options };
  }

  async runTurn(input: TurnInput, tools: AgentToolSet, onEvent: AgentEventSink): Promise<TurnResult> {
    const { budget, activity } = tools;
    const startedAt = Date.now();

    const buckets = new Map<number, PassBucket>();
    const bucketFor = (pass: number): PassBucket => {
      let bucket = buckets.get(pass);
      if (!bucket) {
        bucket = { pass, started: Date.now(), ended: Date.now(), usage: emptyModelUsage() };
        buckets.set(pass, bucket);
      }
      bucket.ended = Date.now();
      return bucket;
    };
    bucketFor(0).started = startedAt;

    /** tool_use_id → unprefixed tool name, learned from the assistant message. */
    const callNames = new Map<string, ToolName>();
    let summary: string | null = null;
    let usage: TurnUsage | null = null;
    let status: TurnStatus = "completed";
    let failure: { code: ScadForgeErrorCode; message: string } | null = null;

    let binding: ClaudeAgentSdkBinding;
    try {
      binding = await this.binding();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onEvent({ type: "error", turn_id: input.turnId, error_code: "AGENT_ERROR", message });
      return { status: "error", summary: null, passesUsed: budget.pass, usage: null, durationMs: Date.now() - startedAt };
    }

    const { prompt, options } = this.buildQuery(binding, input, tools);
    const stream = binding.query({ prompt, options });

    try {
      for await (const message of stream as AsyncIterable<any>) {
        if (input.signal?.aborted) {
          status = "aborted";
          break;
        }

        switch (message?.type) {
          case "stream_event": {
            // The ONLY honest source of per-response usage (Spike 3 §2.4).
            if (message.event?.type === "message_delta" && message.event.usage) {
              const bucket = bucketFor(budget.pass);
              const raw = message.event.usage;
              bucket.usage.input_tokens += raw.input_tokens ?? 0;
              bucket.usage.output_tokens += raw.output_tokens ?? 0;
              bucket.usage.cache_read_input_tokens += raw.cache_read_input_tokens ?? 0;
              bucket.usage.cache_creation_input_tokens += raw.cache_creation_input_tokens ?? 0;
            }
            break;
          }

          case "assistant": {
            for (const block of message.message?.content ?? []) {
              if (block?.type === "text") {
                // CLAUDE.md hard rule 5, enforced host-side.
                const text = sanitizeChatText(String(block.text ?? ""));
                if (!text) continue;
                summary = text;
                onEvent({ type: "assistant_text", turn_id: input.turnId, text });
              } else if (block?.type === "tool_use") {
                const name = unprefixToolName(String(block.name ?? ""));
                if (!name) continue;
                callNames.set(String(block.id), name);
                // A `write_scad` that will be accepted opens the NEXT pass.
                const pass =
                  name === "write_scad" && budget.refusalReason() === null ? budget.pass + 1 : budget.pass;
                onEvent({
                  type: "tool_call",
                  turn_id: input.turnId,
                  tool_call_id: String(block.id),
                  name,
                  pass,
                  input_summary: summarizeToolInput(name, block.input)
                });
                bucketFor(budget.pass);
              }
            }
            break;
          }

          case "user": {
            if (message.isReplay) break;
            for (const block of message.message?.content ?? []) {
              if (block?.type !== "tool_result") continue;
              const id = String(block.tool_use_id);
              const name = callNames.get(id);
              if (!name) continue;
              const recorded = activity.take(name);
              const parsed = parseResultBlock(block.content);
              onEvent({
                type: "tool_result",
                turn_id: input.turnId,
                tool_call_id: id,
                name,
                pass: recorded?.pass ?? budget.pass,
                ok: recorded?.ok ?? parsed.ok ?? false,
                error_code: recorded?.error_code ?? parsed.error_code,
                summary: recorded?.summary ?? null,
                artifacts: recorded?.artifacts ?? [],
                duration_ms: recorded?.duration_ms ?? null
              });
            }
            break;
          }

          case "result": {
            usage = buildTurnUsage(buckets, activity, message);
            if (typeof message.result === "string" && message.result.trim()) {
              summary = sanitizeChatText(message.result) || summary;
            }
            if (message.is_error || message.subtype !== "success") {
              failure = {
                code: "AGENT_ERROR",
                message:
                  (Array.isArray(message.errors) && message.errors[0]) ||
                  (typeof message.result === "string" ? message.result : "") ||
                  `The model provider ended the turn with "${message.subtype}".`
              };
            }
            break;
          }

          default:
            break;
        }
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError" || input.signal?.aborted) {
        status = "aborted";
      } else {
        failure = { code: "AGENT_ERROR", message: error instanceof Error ? error.message : String(error) };
      }
    }

    const now = Date.now();
    for (const bucket of buckets.values()) if (bucket.ended < bucket.started) bucket.ended = now;

    if (status !== "aborted") {
      if (failure) status = "error";
      // A refusal that is purely "validation is already green" is a SUCCESSFUL
      // early stop, not budget exhaustion (CLAUDE.md hard rule 4).
      else if (activity.hasRefusal("budget")) status = "pass_budget_exhausted";
    }

    if (status === "aborted") {
      onEvent({ type: "error", turn_id: input.turnId, error_code: "TURN_ABORTED", message: "The turn was cancelled." });
      usage = null;
      try {
        await stream.interrupt?.();
      } catch {
        // Interrupting a stream that already finished is not an error.
      }
    } else if (failure) {
      onEvent({ type: "error", turn_id: input.turnId, error_code: failure.code, message: failure.message });
    }

    return {
      status,
      summary,
      passesUsed: budget.pass,
      usage,
      durationMs: now - startedAt
    };
  }
}

/** Fold the pass buckets and the SDK's `modelUsage` into protocol's `TurnUsage`. */
function buildTurnUsage(
  buckets: Map<number, PassBucket>,
  activity: { pass(pass: number): { toolCalls: number; images: number } },
  result: any
): TurnUsage {
  const per_pass = [...buckets.values()]
    .sort((a, b) => a.pass - b.pass)
    .map((bucket) => {
      const rollup = activity.pass(bucket.pass);
      return {
        pass: bucket.pass,
        duration_ms: Math.max(0, bucket.ended - bucket.started),
        tool_calls: rollup.toolCalls,
        images: rollup.images,
        ...bucket.usage
      };
    });

  const by_model: Record<string, ModelUsage> = {};
  for (const [model, raw] of Object.entries(result?.modelUsage ?? {})) {
    const entry = raw as Record<string, number>;
    by_model[model] = {
      input_tokens: entry.inputTokens ?? 0,
      output_tokens: entry.outputTokens ?? 0,
      cache_read_input_tokens: entry.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: entry.cacheCreationInputTokens ?? 0
    };
  }

  return { per_pass, by_model, cost_usd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0 };
}

/** Emitted event union re-export, so consumers do not need protocol directly. */
export type { SseEvent };
