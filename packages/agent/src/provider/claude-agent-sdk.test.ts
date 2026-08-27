// SPDX-License-Identifier: Apache-2.0
//
// Provider tests. The SDK boundary is mocked end to end — CI never makes a
// live API call (Issue #16 AC).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SseEvent, ToolCallEvent, ToolResultEvent } from "@scadforge/protocol";

import { MCP_SERVER_NAME, MCP_TOOL_NAME_PREFIX, TOOL_NAMES } from "../tools/contract.js";
import { ToolActivityRecorder } from "../tools/activity.js";
import { createToolHandlers } from "../tools/handlers.js";
import { PassBudget } from "../tools/pass-budget.js";
import { MockLibraryIndex, MockScadCore, healthyReport, redGate } from "../testing/mock-scad-core.js";
import { createFakeSdk, type FakeSdkOptions } from "../testing/fake-sdk.js";
import {
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeAgentSdkProvider,
  MANDATORY_SDK_OPTIONS,
  summarizeToolInput,
  unprefixToolName
} from "./claude-agent-sdk.js";
import type { AgentToolSet, TurnInput } from "./types.js";

function toolSet(scadCore = new MockScadCore(), maxPasses = 2): AgentToolSet & { events: SseEvent[] } {
  const events: SseEvent[] = [];
  const budget = new PassBudget({ maxPasses });
  const activity = new ToolActivityRecorder();
  const handlers = createToolHandlers({
    scadCore,
    libraries: new MockLibraryIndex(),
    budget,
    activity,
    turnId: "turn-1",
    projectId: "proj-1",
    emit: (event) => events.push(event)
  });
  return { handlers, budget, activity, events };
}

function turnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    turnId: "turn-1",
    projectId: "proj-1",
    prompt: "Build this: a 20mm bracket",
    systemPrompt: "system",
    ...overrides
  };
}

async function run(sdkOptions: FakeSdkOptions, tools = toolSet(), input = turnInput()) {
  const sdk = createFakeSdk(sdkOptions);
  const provider = new ClaudeAgentSdkProvider({ binding: sdk.binding });
  const events: SseEvent[] = [];
  const result = await provider.runTurn(input, tools, (event) => events.push(event));
  return { sdk, result, events: [...tools.events, ...events], providerEvents: events, tools };
}

describe("SDK pin", () => {
  it("is pinned EXACTLY, with no range operator", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
    );
    const pinned = pkg.dependencies["@anthropic-ai/claude-agent-sdk"];
    expect(pinned).toBe("0.3.246");
    expect(pinned).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(pinned).not.toMatch(/[\^~*x><=|]/);
  });
});

describe("buildQuery — the mandatory options are the provider's job, never the caller's", () => {
  const sdk = createFakeSdk({ turns: [] });
  const provider = new ClaudeAgentSdkProvider({ binding: sdk.binding });
  const built = provider.buildQuery(sdk.binding, turnInput(), toolSet());

  it("always sets settingSources: [] (omitting it leaks the operator's ~/.claude config)", () => {
    expect(built.options.settingSources).toEqual([]);
    expect(Array.isArray(built.options.settingSources)).toBe(true);
  });

  it("always sets tools: [] (otherwise MCP tools defer behind ToolSearch)", () => {
    expect(built.options.tools).toEqual([]);
  });

  it("always sets includePartialMessages: true (the only honest usage source)", () => {
    expect(built.options.includePartialMessages).toBe(true);
  });

  it("bypasses permissions, since handlers run in-process with no interactive host", () => {
    expect(built.options.permissionMode).toBe("bypassPermissions");
    expect(built.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("exposes MANDATORY_SDK_OPTIONS as the single source of those five", () => {
    for (const [key, value] of Object.entries(MANDATORY_SDK_OPTIONS)) {
      expect(built.options[key]).toEqual(value);
    }
  });

  it("registers all seven contract tools on one MCP server and allow-lists them prefixed", () => {
    expect(sdk.registeredTools().sort()).toEqual([...TOOL_NAMES].sort());
    expect(built.options.allowedTools).toEqual(TOOL_NAMES.map((n) => `${MCP_TOOL_NAME_PREFIX}${n}`));
    expect(Object.keys(built.options.mcpServers as object)).toEqual([MCP_SERVER_NAME]);
  });

  it("passes the system prompt and an abort controller through", () => {
    expect(built.options.systemPrompt).toBe("system");
    expect(built.options.abortController).toBeInstanceOf(AbortController);
  });

  it("omits `model` when none was requested and forwards it when one was", () => {
    expect(built.options.model).toBeUndefined();
    const withModel = provider.buildQuery(sdk.binding, turnInput({ model: "claude-sonnet-4-5" }), toolSet());
    expect(withModel.options.model).toBe("claude-sonnet-4-5");
  });

  it("does not leak the SDK's maxTurns into the pass budget", () => {
    // Spike 3 §6 amendment 3: maxTurns counts API round trips, not build passes.
    expect(built.options.maxTurns).toBe(40);
  });
});

describe("tool-name prefixing", () => {
  it("strips the mcp__scadforge__ prefix", () => {
    expect(unprefixToolName(`${MCP_TOOL_NAME_PREFIX}write_scad`)).toBe("write_scad");
    expect(unprefixToolName("write_scad")).toBe("write_scad");
  });
  it("rejects anything outside the frozen tool set", () => {
    expect(unprefixToolName("mcp__scadforge__Bash")).toBeNull();
    expect(unprefixToolName("Read")).toBeNull();
  });
});

describe("summarizeToolInput", () => {
  it("never returns .scad source for write_scad", () => {
    const summary = summarizeToolInput("write_scad", {
      content: "module bracket() { cube(10); }",
      message: "added the mounting boss"
    });
    expect(summary).toBe("added the mounting boss");
    expect(summary).not.toContain("module");
  });
  it("strips a fenced block a model smuggled into the message", () => {
    expect(summarizeToolInput("write_scad", { message: "fix\n```scad\ncube(1);\n```" })).toBe("fix");
  });
  it("summarizes the other tools compactly", () => {
    expect(summarizeToolInput("render_views", { views: ["iso", "section"] })).toBe("iso, section");
    expect(summarizeToolInput("render_views", {})).toBe("default views");
    expect(summarizeToolInput("set_params", { params: { wall: 3 } })).toBe("wall");
    expect(summarizeToolInput("export", { format: "3mf" })).toBe("3mf");
    expect(summarizeToolInput("read_project", {})).toBeNull();
  });
});

describe("runTurn — event mapping", () => {
  it("emits the frozen SSE union and never a prefixed tool name", async () => {
    const { events } = await run({
      turns: [
        {
          text: "Planning a 20mm bracket.",
          toolUses: [{ name: "write_scad", input: { content: "cube(20);", message: "initial bracket" } }],
          usage: { input_tokens: 100, output_tokens: 50 }
        },
        {
          toolUses: [{ name: "render_views", input: { views: ["iso", "front"] } }],
          usage: { input_tokens: 200, output_tokens: 20 }
        },
        { text: "Done: a 20mm bracket.", usage: { input_tokens: 300, output_tokens: 30 } }
      ],
      result: { result: "Done: a 20mm bracket with wall and size parameters." }
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("assistant_text");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("snapshot_created");

    for (const event of events) {
      if (event.type === "tool_call" || event.type === "tool_result") {
        expect(event.name.startsWith("mcp__")).toBe(false);
        expect(TOOL_NAMES).toContain(event.name);
      }
    }
  });

  it("correlates tool_call and tool_result by tool_call_id", async () => {
    const { events } = await run({
      turns: [
        { toolUses: [{ name: "write_scad", input: { content: "cube(20);", message: "bracket" } }] },
        { toolUses: [{ name: "validate_mesh", input: {} }] }
      ]
    });
    const calls = events.filter((e): e is ToolCallEvent => e.type === "tool_call");
    const results = events.filter((e): e is ToolResultEvent => e.type === "tool_result");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    for (const [index, call] of calls.entries()) {
      expect(results[index].tool_call_id).toBe(call.tool_call_id);
      expect(results[index].name).toBe(call.name);
    }
  });

  it("labels the write_scad tool_call with the pass it OPENS, not the one before it", async () => {
    const { events } = await run({
      turns: [{ toolUses: [{ name: "write_scad", input: { content: "cube(20);", message: "bracket" } }] }]
    });
    const call = events.find((e): e is ToolCallEvent => e.type === "tool_call")!;
    const result = events.find((e): e is ToolResultEvent => e.type === "tool_result")!;
    expect(call.pass).toBe(1);
    expect(result.pass).toBe(1);
  });

  it("strips fenced blocks from assistant_text host-side", async () => {
    const { events } = await run({
      turns: [{ text: "Here it is:\n```scad\nmodule bracket() { cube(10); }\n```\nIt is 10mm." }]
    });
    const texts = events.filter((e) => e.type === "assistant_text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { text: string }).text).toBe("Here it is:\n\nIt is 10mm.");
    expect((texts[0] as { text: string }).text).not.toContain("module");
  });

  it("suppresses an assistant message that was ONLY a code block", async () => {
    const { events } = await run({ turns: [{ text: "```scad\ncube(10);\n```" }] });
    expect(events.filter((e) => e.type === "assistant_text")).toHaveLength(0);
  });

  it("carries render artifacts as URLs on tool_result, never base64", async () => {
    const { events } = await run({
      turns: [{ toolUses: [{ name: "render_views", input: { views: ["iso"] } }] }]
    });
    const result = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result" && e.name === "render_views"
    )!;
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].kind).toBe("render");
    expect(result.artifacts[0].view).toBe("iso");
    expect(JSON.stringify(result.artifacts)).not.toContain("aGVsbG8");
  });
});

describe("runTurn — usage accounting", () => {
  it("sums usage ONLY from message_delta, per pass, and reports per model", async () => {
    const { result } = await run({
      turns: [
        {
          toolUses: [{ name: "write_scad", input: { content: "cube(20);", message: "bracket" } }],
          usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 50 }
        },
        {
          toolUses: [{ name: "render_views", input: { views: ["iso", "front"] } }],
          usage: { input_tokens: 2000, output_tokens: 40, cache_creation_input_tokens: 7 }
        }
      ],
      result: {
        total_cost_usd: 0.1412,
        modelUsage: {
          "claude-opus-4-5": {
            inputTokens: 3000,
            outputTokens: 140,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 7
          },
          "claude-haiku-4-5": {
            inputTokens: 920,
            outputTokens: 12,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0
          }
        }
      }
    });

    const usage = result.usage!;
    expect(usage.cost_usd).toBeCloseTo(0.1412);

    // Pass 0 is the planning bucket; the write_scad response bills to pass 1,
    // because its message_delta lands after the tool call that opened it.
    const byPass = Object.fromEntries(usage.per_pass.map((p) => [p.pass, p]));
    expect(byPass[1].input_tokens).toBe(3000);
    expect(byPass[1].output_tokens).toBe(140);
    expect(byPass[1].cache_read_input_tokens).toBe(50);
    expect(byPass[1].cache_creation_input_tokens).toBe(7);
    expect(byPass[1].images).toBe(2);
    expect(byPass[1].tool_calls).toBe(2);

    // The auxiliary haiku call the SDK always bills is attributed, not hidden.
    expect(Object.keys(usage.by_model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-4-5"]);
    expect(usage.by_model["claude-haiku-4-5"]).toEqual({
      input_tokens: 920,
      output_tokens: 12,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    });
  });

  it("never sums the message_start placeholder from an assistant message", async () => {
    const sdk = createFakeSdk({ turns: [], result: { modelUsage: {} } });
    const provider = new ClaudeAgentSdkProvider({ binding: sdk.binding });
    const tools = toolSet();
    // A hand-rolled stream whose assistant message carries a (placeholder) usage
    // object: it must be ignored entirely.
    const binding = {
      ...sdk.binding,
      query: () =>
        Object.assign(
          (async function* () {
            yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 999_999 } } };
            yield { type: "result", subtype: "success", is_error: false, result: "hi", total_cost_usd: 0, modelUsage: {} };
          })(),
          { interrupt: async () => undefined }
        )
    };
    const withPlaceholder = new ClaudeAgentSdkProvider({ binding });
    const result = await withPlaceholder.runTurn(turnInput(), tools, () => {});
    expect(result.usage!.per_pass.every((p) => p.input_tokens === 0)).toBe(true);
    expect(provider.id).toBe("claude-agent-sdk");
  });
});

describe("runTurn — terminal status", () => {
  it("reports completed on a clean turn", async () => {
    const { result } = await run({
      turns: [{ toolUses: [{ name: "write_scad", input: { content: "cube(20);", message: "bracket" } }] }],
      result: { result: "A 20mm bracket." }
    });
    expect(result.status).toBe("completed");
    expect(result.passesUsed).toBe(1);
    expect(result.summary).toBe("A 20mm bracket.");
  });

  it("reports pass_budget_exhausted when a write was refused for budget", async () => {
    const write = { name: "write_scad" as const, input: { content: "cube(20);", message: "x" } };
    // A red gate keeps the correction budget open, so the third write is
    // refused for the budget rather than for the green early stop.
    const scadCore = new MockScadCore({
      validate: { report: healthyReport({ components: 2 }), gate: redGate(), export_ms: 700, validate_ms: 30 }
    });
    const { result, tools } = await run(
      {
        turns: [
          { toolUses: [write] },
          { toolUses: [{ name: "validate_mesh" as const, input: {} }] },
          { toolUses: [write] },
          { toolUses: [write] }
        ],
        result: { result: "Ran out of passes." }
      },
      toolSet(scadCore)
    );
    expect(result.status).toBe("pass_budget_exhausted");
    expect(result.passesUsed).toBe(2);
    expect(tools.activity.hasRefusal("budget")).toBe(true);
  });

  it("treats a green-validation early stop as COMPLETED, not exhaustion", async () => {
    const { result, tools } = await run({
      turns: [
        { toolUses: [{ name: "write_scad", input: { content: "cube(20);", message: "x" } }] },
        { toolUses: [{ name: "validate_mesh", input: {} }] },
        { toolUses: [{ name: "write_scad", input: { content: "cube(21);", message: "polish" } }] }
      ],
      result: { result: "Green on the first pass." }
    });
    expect(result.status).toBe("completed");
    expect(tools.activity.hasRefusal("green")).toBe(true);
    expect(tools.budget.pass).toBe(1);
  });

  it("reports error and emits an error event when the SDK result is an error", async () => {
    const { result, providerEvents } = await run({
      turns: [],
      result: { subtype: "error_during_execution", is_error: true, errors: ["upstream 529"] }
    });
    expect(result.status).toBe("error");
    const errors = providerEvents.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ error_code: "AGENT_ERROR", message: "upstream 529" });
  });

  it("reports error when the stream throws", async () => {
    const { result, providerEvents } = await run({
      turns: [{ text: "starting" }],
      throwAfter: { turns: 1, error: new Error("cli exited with code 1") }
    });
    expect(result.status).toBe("error");
    expect(providerEvents.some((e) => e.type === "error" && e.message.includes("cli exited"))).toBe(true);
  });

  it("reports aborted, drops usage and interrupts the stream on an AbortError", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { result, providerEvents, sdk } = await run({
      turns: [{ text: "working" }],
      throwAfter: { turns: 1, error: abort }
    });
    expect(result.status).toBe("aborted");
    expect(result.usage).toBeNull();
    expect(sdk.interrupted()).toBe(true);
    expect(providerEvents.some((e) => e.type === "error" && e.error_code === "TURN_ABORTED")).toBe(true);
  });

  it("stops as soon as an already-aborted signal is seen", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run(
      { turns: [{ text: "one" }, { text: "two" }] },
      toolSet(),
      turnInput({ signal: controller.signal })
    );
    expect(result.status).toBe("aborted");
  });

  it("fails cleanly when the SDK itself cannot be loaded", async () => {
    const provider = new ClaudeAgentSdkProvider({
      binding: undefined,
      // Force the lazy import path to fail without touching node_modules.
    });
    provider.binding = async () => {
      throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
    };
    const events: SseEvent[] = [];
    const result = await provider.runTurn(turnInput(), toolSet(), (event) => events.push(event));
    expect(result.status).toBe("error");
    expect(events[0]).toMatchObject({ type: "error", error_code: "AGENT_ERROR" });
  });
});

describe("runTurn — handler failures do not abort the turn", () => {
  it("emits a tool_result carrying the failure and keeps going", async () => {
    const scadCore = new MockScadCore({ failures: { renderViews: new Error("openscad crashed") } });
    const { events, result } = await run(
      {
        turns: [
          { toolUses: [{ name: "write_scad", input: { content: "cube(20);", message: "bracket" } }] },
          { toolUses: [{ name: "render_views", input: {} }] },
          { text: "The render failed; the model is written but unverified." }
        ],
        result: { result: "The render failed; the model is written but unverified." }
      },
      toolSet(scadCore)
    );
    const renderResult = events.find(
      (e): e is ToolResultEvent => e.type === "tool_result" && e.name === "render_views"
    )!;
    expect(renderResult.ok).toBe(false);
    expect(renderResult.error_code).toBe("RENDER_FAILED");
    expect(result.status).toBe("completed");
  });
});
