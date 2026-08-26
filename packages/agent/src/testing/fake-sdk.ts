// SPDX-License-Identifier: Apache-2.0
//
// A scripted stand-in for `@anthropic-ai/claude-agent-sdk`.
//
// It reproduces the message ORDER the real SDK produces — assistant (text +
// tool_use), then the tool_result user message, then the `message_delta` stream
// event that bills the response, then a terminal `result` — so the provider's
// pass bucketing and event mapping are exercised end to end with ZERO live API
// calls. CI never talks to the API (Issue #16 AC).

import { MCP_TOOL_NAME_PREFIX, type ToolName } from "../tools/contract.js";
import type { ClaudeAgentSdkBinding } from "../provider/claude-agent-sdk.js";

/** Raw `message_delta` usage, in the API's snake_case. */
export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** One scripted assistant response. */
export interface FakeTurn {
  /** Assistant prose. Emitted verbatim; the provider is what sanitizes it. */
  text?: string;
  /** Tool calls this response makes. Handlers really run. */
  toolUses?: Array<{ name: ToolName; input?: unknown }>;
  /** Usage billed to this response. */
  usage?: FakeUsage;
}

/** The terminal `result` message. */
export interface FakeResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  modelUsage?: Record<string, Record<string, number>>;
}

/** Options for {@link createFakeSdk}. */
export interface FakeSdkOptions {
  turns: FakeTurn[];
  result?: FakeResult | null;
  /** Thrown from the message loop after `throwAfterTurns` responses. */
  throwAfter?: { turns: number; error: unknown };
}

/** What {@link createFakeSdk} hands back. */
export interface FakeSdk {
  binding: ClaudeAgentSdkBinding;
  /** The options object the provider passed to `query()`. */
  queryOptions(): Record<string, unknown> | null;
  /** The prompt the provider passed to `query()`. */
  queryPrompt(): string | null;
  /** Tool names registered on the MCP server, as the model sees them. */
  registeredTools(): string[];
  /** True once `interrupt()` was called. */
  interrupted(): boolean;
}

/** Build a scripted SDK binding. */
export function createFakeSdk(options: FakeSdkOptions): FakeSdk {
  const registry = new Map<string, (args: any, extra: unknown) => Promise<any>>();
  let capturedOptions: Record<string, unknown> | null = null;
  let capturedPrompt: string | null = null;
  let wasInterrupted = false;

  const binding: ClaudeAgentSdkBinding = {
    tool(name, description, inputSchema, handler) {
      return { name, description, inputSchema, handler };
    },
    createSdkMcpServer(serverOptions) {
      for (const definition of serverOptions.tools) {
        registry.set(definition.name, definition.handler);
      }
      return { type: "sdk", name: serverOptions.name, instance: {} };
    },
    query(params) {
      capturedPrompt = params.prompt;
      capturedOptions = params.options ?? null;

      async function* generate(): AsyncGenerator<any> {
        yield { type: "system", subtype: "init", session_id: "fake-session", model: "fake-model" };

        let callId = 0;
        let index = 0;
        for (const turn of options.turns) {
          if (options.throwAfter && index === options.throwAfter.turns) throw options.throwAfter.error;
          index += 1;

          const content: any[] = [];
          if (turn.text) content.push({ type: "text", text: turn.text });
          const issued: Array<{ id: string; name: ToolName; input: unknown }> = [];
          for (const use of turn.toolUses ?? []) {
            callId += 1;
            const id = `call_${callId}`;
            issued.push({ id, name: use.name, input: use.input ?? {} });
            content.push({
              type: "tool_use",
              id,
              // The model addresses MCP tools by their prefixed name.
              name: `${MCP_TOOL_NAME_PREFIX}${use.name}`,
              input: use.input ?? {}
            });
          }
          yield { type: "assistant", message: { content } };

          for (const use of issued) {
            const handler = registry.get(use.name);
            if (!handler) throw new Error(`fake sdk: no handler registered for ${use.name}`);
            const result = await handler(use.input, {});
            yield {
              type: "user",
              isReplay: false,
              message: {
                content: [{ type: "tool_result", tool_use_id: use.id, content: result.content }]
              }
            };
          }

          // The delta lands AFTER this response's tool calls have run — which is
          // exactly what makes it bill to the pass those calls opened.
          yield { type: "stream_event", event: { type: "message_delta", usage: turn.usage ?? {} } };
        }

        if (options.throwAfter && index === options.throwAfter.turns) throw options.throwAfter.error;

        if (options.result !== null) {
          const result = options.result ?? {};
          yield {
            type: "result",
            subtype: result.subtype ?? "success",
            is_error: result.is_error ?? false,
            result: result.result ?? "",
            errors: result.errors ?? [],
            duration_ms: 1234,
            duration_api_ms: 1000,
            num_turns: options.turns.length,
            total_cost_usd: result.total_cost_usd ?? 0.08,
            modelUsage: result.modelUsage ?? {
              "claude-haiku-4-5": {
                inputTokens: 920,
                outputTokens: 12,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0
              }
            }
          };
        }
      }

      const iterator = generate();
      return Object.assign(iterator, {
        async interrupt() {
          wasInterrupted = true;
          return undefined;
        }
      });
    }
  };

  return {
    binding,
    queryOptions: () => capturedOptions,
    queryPrompt: () => capturedPrompt,
    registeredTools: () => [...registry.keys()],
    interrupted: () => wasInterrupted
  };
}
