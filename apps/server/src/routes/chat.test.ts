import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createFakeScadCoreApi, createScriptedAgentProvider } from "../test/fakes.js";
import type { AgentEventSink, AgentTurnInput } from "../services/agent-provider.js";

interface ParsedFrame {
  event: string;
  data: unknown;
}

/** Parses `event: <type>\ndata: <json>\n\n` frames (protocol/src/events.ts framing). */
function parseSse(raw: string): ParsedFrame[] {
  return raw
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      return {
        event: eventLine ? eventLine.slice("event:".length).trim() : "",
        data: dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : undefined
      };
    });
}

async function createProject(app: ReturnType<typeof createApp>, name = "chat-test") {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  return res.json();
}

describe("POST /api/projects/:projectId/chat", () => {
  it("streams the frozen SSE event union in exact order for a full mocked turn", async () => {
    const scadCore = createFakeScadCoreApi();
    const agent = createScriptedAgentProvider([
      (turnId) => ({
        type: "tool_call",
        turn_id: turnId,
        tool_call_id: "call-1",
        name: "write_scad",
        pass: 0,
        input_summary: "cube 10x10x10"
      }),
      (turnId) => ({
        type: "tool_result",
        turn_id: turnId,
        tool_call_id: "call-1",
        name: "write_scad",
        pass: 0,
        ok: true,
        error_code: null,
        summary: "Wrote model.scad",
        artifacts: [],
        duration_ms: 5
      }),
      (turnId) => ({ type: "assistant_text", turn_id: turnId, text: "Made a 10mm cube." }),
      (turnId) => ({
        type: "snapshot_created",
        turn_id: turnId,
        project_id: "irrelevant-here",
        snapshot: {
          id: "0002",
          parent: "0001",
          timestamp: new Date().toISOString(),
          message: "Made a 10mm cube.",
          origin: "agent",
          pass: 0,
          files: {
            model_scad: "model.scad",
            params_json: "params.json",
            message_md: "message.md",
            validation_json: null,
            diff_patch: null
          },
          params: {},
          renders: [],
          validation: null,
          annotations: []
        }
      }),
      (turnId) => ({
        type: "turn_done",
        turn_id: turnId,
        status: "completed",
        passes_used: 1,
        summary: "Made a 10mm cube.",
        usage: null,
        duration_ms: 42
      })
    ]);
    const app = createApp({ scadCore, agent });
    const project = await createProject(app);

    const res = await app.request(`/api/projects/${project.project.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Make me a 10mm cube" })
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSse(await res.text());
    expect(frames.map((f) => f.event)).toEqual([
      "turn_started",
      "tool_call",
      "tool_result",
      "assistant_text",
      "snapshot_created",
      "turn_done"
    ]);

    const turnId = (frames[0].data as { turn_id: string }).turn_id;
    for (const frame of frames) {
      expect((frame.data as { turn_id: string | null }).turn_id).toBe(turnId);
    }
    expect(frames.at(-1)!.data).toMatchObject({ status: "completed", passes_used: 1 });
  });

  it("returns PROJECT_NOT_FOUND (plain JSON, not SSE) for an unknown project id", async () => {
    const app = createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
    const res = await app.request("/api/projects/does-not-exist/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" })
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: "PROJECT_NOT_FOUND" });
  });

  it("rejects a path-traversal project id as INVALID_REQUEST before opening a stream", async () => {
    const app = createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
    const res = await app.request("/api/projects/..%2F..%2Fetc/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("rejects a missing message with INVALID_REQUEST", async () => {
    const app = createApp({ scadCore: createFakeScadCoreApi(), agent: createScriptedAgentProvider([]) });
    const project = await createProject(app);
    const res = await app.request(`/api/projects/${project.project.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "INVALID_REQUEST" });
  });

  it("emits an error event then a synthetic turn_done, and closes cleanly, on a mid-stream provider crash", async () => {
    const agent = createScriptedAgentProvider(async (_input: AgentTurnInput) => {
      throw new Error("boom: simulated provider crash mid-turn");
    });
    const app = createApp({ scadCore: createFakeScadCoreApi(), agent });
    const project = await createProject(app);

    const res = await app.request(`/api/projects/${project.project.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "trigger a crash" })
    });

    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    expect(frames.map((f) => f.event)).toEqual(["turn_started", "error", "turn_done"]);
    expect(frames[1].data).toMatchObject({ error_code: "AGENT_ERROR" });
    expect(frames[2].data).toMatchObject({ status: "error" });
  });

  it("reports a RouteError thrown by the provider under its own error_code", async () => {
    const { RouteError } = await import("../services/errors.js");
    const agent = createScriptedAgentProvider(async () => {
      throw new RouteError("RENDER_FAILED", "render exploded");
    });
    const app = createApp({ scadCore: createFakeScadCoreApi(), agent });
    const project = await createProject(app);

    const res = await app.request(`/api/projects/${project.project.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "render please" })
    });

    const frames = parseSse(await res.text());
    expect(frames.map((f) => f.event)).toEqual(["turn_started", "error", "turn_done"]);
    expect(frames[1].data).toMatchObject({ error_code: "RENDER_FAILED" });
  });

  it("documents the concurrency policy: a second turn on the same project gets 409 CONFLICT", async () => {
    let releaseFirstTurn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const agent = createScriptedAgentProvider(async (_input: AgentTurnInput) => {
      await gate;
    });
    const app = createApp({ scadCore: createFakeScadCoreApi(), agent });
    const project = await createProject(app);

    const firstTurn = app.request(`/api/projects/${project.project.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "first" })
    });

    // Give the first request a tick to register as busy before firing the second.
    await new Promise((r) => setTimeout(r, 10));

    const second = await app.request(`/api/projects/${project.project.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "second" })
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error_code: "CONFLICT" });

    releaseFirstTurn();
    const firstRes = await firstTurn;
    await firstRes.text(); // drain so the fake handler/test settle cleanly
  });
});

// Keeps the shared `AgentEventSink` type referenced so a future refactor of
// `createScriptedAgentProvider`'s signature is caught here too.
const _typeCheck: AgentEventSink = () => {};
void _typeCheck;
