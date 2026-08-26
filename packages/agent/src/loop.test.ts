// SPDX-License-Identifier: Apache-2.0
//
// Turn-orchestration tests. Everything runs against the in-memory seams and the
// scripted SDK — no live API calls, no Docker.

import { describe, expect, it } from "vitest";
import type { SseEvent, TurnDoneEvent, TurnStartedEvent } from "@scadforge/protocol";
import { SSE_EVENT_TYPES } from "@scadforge/protocol";

import { runAgentTurn, type RunAgentTurnOptions } from "./loop.js";
import { ClaudeAgentSdkProvider } from "./provider/claude-agent-sdk.js";
import { MAX_PASSES_ENV_VAR } from "./tools/contract.js";
import { MockLibraryIndex, MockScadCore, healthyReport, redGate } from "./testing/mock-scad-core.js";
import { createFakeSdk, type FakeSdkOptions } from "./testing/fake-sdk.js";
import type { ModelProvider } from "./provider/types.js";

const WRITE = { name: "write_scad" as const, input: { content: "cube(20);", message: "a 20mm cube" } };

function turn(
  sdkOptions: FakeSdkOptions,
  overrides: Partial<RunAgentTurnOptions> = {},
  scadCore = new MockScadCore()
) {
  const sdk = createFakeSdk(sdkOptions);
  const events: SseEvent[] = [];
  const options: RunAgentTurnOptions = {
    projectId: "proj-1",
    message: "a 20mm bracket",
    provider: new ClaudeAgentSdkProvider({ binding: sdk.binding }),
    scadCore,
    libraries: new MockLibraryIndex(),
    onEvent: (event) => events.push(event),
    env: {},
    ...overrides
  };
  return { run: () => runAgentTurn(options), events, sdk, scadCore };
}

describe("runAgentTurn — lifecycle", () => {
  it("opens with turn_started and closes with turn_done, always last", async () => {
    const t = turn({
      turns: [{ toolUses: [WRITE] }, { toolUses: [{ name: "validate_mesh", input: {} }] }],
      result: { result: "A 20mm bracket." }
    });
    const outcome = await t.run();

    expect(t.events[0].type).toBe("turn_started");
    expect(t.events[t.events.length - 1].type).toBe("turn_done");
    expect(t.events.filter((e) => e.type === "turn_started")).toHaveLength(1);
    expect(t.events.filter((e) => e.type === "turn_done")).toHaveLength(1);

    const started = t.events[0] as TurnStartedEvent;
    expect(started).toMatchObject({ project_id: "proj-1", max_passes: 2 });
    expect(() => new Date(started.started_at).toISOString()).not.toThrow();

    const done = t.events[t.events.length - 1] as TurnDoneEvent;
    expect(done).toMatchObject({ status: "completed", passes_used: 1, turn_id: outcome.turnId });
    expect(done.summary).toBe("A 20mm bracket.");
    expect(done.usage).not.toBeNull();
  });

  it("stamps one turn_id on every event", async () => {
    const t = turn({ turns: [{ toolUses: [WRITE] }] });
    const outcome = await t.run();
    for (const event of t.events) {
      expect("turn_id" in event ? event.turn_id : outcome.turnId).toBe(outcome.turnId);
    }
  });

  it("emits only members of the frozen SSE union", async () => {
    const t = turn({
      turns: [{ text: "Working.", toolUses: [WRITE] }, { toolUses: [{ name: "render_views", input: {} }] }]
    });
    await t.run();
    for (const event of t.events) expect(SSE_EVENT_TYPES).toContain(event.type);
    expect(new Set(t.events.map((e) => e.type))).toContain("snapshot_created");
  });
});

describe("runAgentTurn — counterexamples", () => {
  it("rejects an EMPTY prompt with INVALID_REQUEST and still closes the turn", async () => {
    const t = turn({ turns: [] }, { message: "   " });
    const outcome = await t.run();

    expect(outcome.status).toBe("error");
    expect(outcome.passesUsed).toBe(0);
    expect(t.events.map((e) => e.type)).toEqual(["turn_started", "error", "turn_done"]);
    expect(t.events[1]).toMatchObject({ error_code: "INVALID_REQUEST" });
    // The provider was never reached.
    expect(t.sdk.queryPrompt()).toBeNull();
  });

  it("survives a scad-core failure mid-turn", async () => {
    const scadCore = new MockScadCore({ failures: { validateMesh: new Error("manifold-3d threw") } });
    const t = turn(
      {
        turns: [
          { toolUses: [WRITE] },
          { toolUses: [{ name: "validate_mesh", input: {} }] },
          { text: "The mesh could not be validated." }
        ],
        result: { result: "The mesh could not be validated." }
      },
      {},
      scadCore
    );
    const outcome = await t.run();
    expect(outcome.status).toBe("completed");
    const failed = t.events.find((e) => e.type === "tool_result" && e.name === "validate_mesh");
    expect(failed).toMatchObject({ ok: false, error_code: "MESH_PARSE_FAILED" });
  });

  it("reports pass_budget_exhausted on turn_done when the cap is hit", async () => {
    const scadCore = new MockScadCore({
      validate: { report: healthyReport({ components: 2 }), gate: redGate(), export_ms: 1, validate_ms: 1 }
    });
    const t = turn(
      {
        turns: [
          { toolUses: [WRITE] },
          { toolUses: [{ name: "validate_mesh", input: {} }] },
          { toolUses: [WRITE] },
          { toolUses: [WRITE] },
          { text: "Out of passes; the part is still in two pieces." }
        ],
        result: { result: "Out of passes; the part is still in two pieces." }
      },
      {},
      scadCore
    );
    const outcome = await t.run();
    expect(outcome.status).toBe("pass_budget_exhausted");
    expect(outcome.passesUsed).toBe(2);
    expect((t.events[t.events.length - 1] as TurnDoneEvent).status).toBe("pass_budget_exhausted");
  });

  it("stops early on green validation and still reports completed", async () => {
    const t = turn({
      turns: [
        { toolUses: [WRITE] },
        { toolUses: [{ name: "validate_mesh", input: {} }] },
        { toolUses: [WRITE] },
        { text: "Green on the first pass." }
      ],
      result: { result: "Green on the first pass." }
    });
    const outcome = await t.run();
    expect(outcome.status).toBe("completed");
    expect(outcome.passesUsed).toBe(1);
  });

  it("strips fenced .scad out of the final summary too", async () => {
    const t = turn({
      turns: [{ toolUses: [WRITE] }],
      result: { result: "Here is the file:\n```scad\nmodule bracket(){cube(10);}\n```\nDone." }
    });
    const outcome = await t.run();
    expect(outcome.summary).toBe("Here is the file:\n\nDone.");
    expect(outcome.summary).not.toContain("module");
  });

  it("survives a provider that throws outright", async () => {
    const provider: ModelProvider = {
      id: "exploding",
      async runTurn() {
        throw new Error("provider exploded");
      }
    };
    const t = turn({ turns: [] }, { provider });
    const outcome = await t.run();
    expect(outcome.status).toBe("error");
    expect(t.events.some((e) => e.type === "error" && e.error_code === "AGENT_ERROR")).toBe(true);
    expect(t.events[t.events.length - 1].type).toBe("turn_done");
  });

  it("classifies an aborted provider as aborted, not error", async () => {
    const provider: ModelProvider = {
      id: "aborting",
      async runTurn() {
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      }
    };
    const t = turn({ turns: [] }, { provider });
    const outcome = await t.run();
    expect(outcome.status).toBe("aborted");
    expect(t.events.some((e) => e.type === "error" && e.error_code === "TURN_ABORTED")).toBe(true);
  });
});

describe("runAgentTurn — configuration", () => {
  it("reads SCADFORGE_MAX_PASSES from the supplied env bag", async () => {
    const t = turn({ turns: [] }, { env: { [MAX_PASSES_ENV_VAR]: "1" } });
    const outcome = await t.run();
    expect(outcome.maxPasses).toBe(1);
    expect((t.events[0] as TurnStartedEvent).max_passes).toBe(1);
  });

  it("lets an explicit maxPasses win over the environment", async () => {
    const t = turn({ turns: [] }, { maxPasses: 4, env: { [MAX_PASSES_ENV_VAR]: "1" } });
    expect((await t.run()).maxPasses).toBe(4);
  });

  it("threads the pass budget into the system prompt handed to the SDK", async () => {
    const t = turn({ turns: [] }, { maxPasses: 3 });
    await t.run();
    expect(String(t.sdk.queryOptions()!.systemPrompt)).toContain("3 write_scad calls per turn");
  });

  it("honours a caller-supplied turnId and system prompt", async () => {
    const t = turn({ turns: [] }, { turnId: "turn-abc", systemPrompt: "CUSTOM" });
    const outcome = await t.run();
    expect(outcome.turnId).toBe("turn-abc");
    expect(t.sdk.queryOptions()!.systemPrompt).toBe("CUSTOM");
  });

  it("uses the inspect-first turn prompt when a model already exists", async () => {
    const t = turn({ turns: [] }, { hasExistingModel: true, message: "thicker walls" });
    await t.run();
    expect(t.sdk.queryPrompt()).toMatch(/read_project first/);
  });

  it("mints a distinct turn id per turn", async () => {
    const a = await turn({ turns: [] }).run();
    const b = await turn({ turns: [] }).run();
    expect(a.turnId).not.toBe(b.turnId);
  });
});
