import { describe, expect, it } from "vitest";
import type { SnapshotManifest, SseEvent } from "@scadforge/protocol";
import { initialChatState, reduceChatAction, reduceChatEvent, reduceChatEvents } from "./chatReducer.js";
import type { ChatItem } from "./chatReducer.js";

const TURN_ID = "turn-1";

function turnStarted(): SseEvent {
  return { type: "turn_started", turn_id: TURN_ID, project_id: "p1", max_passes: 2, started_at: "2026-08-26T00:00:00.000Z" };
}

describe("reduceChatEvents", () => {
  it("accumulates consecutive assistant_text chunks into one growing item", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "assistant_text", turn_id: TURN_ID, text: "Building " },
      { type: "assistant_text", turn_id: TURN_ID, text: "a bracket." }
    ];
    const state = reduceChatEvents(events);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "assistant_text", text: "Building a bracket." });
  });

  it("tracks tool_call → tool_result as one compact activity row, no raw payloads", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "tool_call", turn_id: TURN_ID, tool_call_id: "call-1", name: "render_views", pass: 0, input_summary: "iso, front" },
      {
        type: "tool_result",
        turn_id: TURN_ID,
        tool_call_id: "call-1",
        name: "render_views",
        pass: 0,
        ok: true,
        error_code: null,
        summary: "Rendered 2 views",
        artifacts: [{ kind: "render", view: "iso", url: "/api/projects/p1/snapshots/0002/views/iso", bytes: 1024 }],
        duration_ms: 1200
      }
    ];
    const state = reduceChatEvents(events);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "tool_activity",
      name: "render_views",
      status: "ok",
      summary: "Rendered 2 views"
    });
    // Counterexample guard: nothing resembling a full envelope/payload dump.
    expect(JSON.stringify(state.items[0])).not.toContain("bytes");
  });

  it("marks a failed tool_result distinctly from a running one", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "tool_call", turn_id: TURN_ID, tool_call_id: "call-1", name: "write_scad", pass: 0, input_summary: null },
      {
        type: "tool_result",
        turn_id: TURN_ID,
        tool_call_id: "call-1",
        name: "write_scad",
        pass: 0,
        ok: false,
        error_code: "SYNTAX_ERROR",
        summary: "Syntax error on line 4",
        artifacts: [],
        duration_ms: 40
      }
    ];
    const state = reduceChatEvents(events);
    expect(state.items[0]).toMatchObject({ kind: "tool_activity", status: "failed", summary: "Syntax error on line 4" });
  });

  it("captures the latest mesh artifact from a tool_result for the 3D viewer", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "tool_call", turn_id: TURN_ID, tool_call_id: "call-1", name: "validate_mesh", pass: 0, input_summary: null },
      {
        type: "tool_result",
        turn_id: TURN_ID,
        tool_call_id: "call-1",
        name: "validate_mesh",
        pass: 0,
        ok: true,
        error_code: null,
        summary: "Manifold, green",
        artifacts: [{ kind: "mesh", view: null, url: "/api/projects/p1/renders/0002.stl", bytes: 4096 }],
        duration_ms: 300
      }
    ];
    const state = reduceChatEvents(events);
    expect(state.latestMeshUrl).toBe("/api/projects/p1/renders/0002.stl");
  });

  it("records the head snapshot on snapshot_created without adding a transcript item", () => {
    const manifest: SnapshotManifest = {
      id: "0002",
      parent: "0001",
      timestamp: "2026-08-26T00:00:00.000Z",
      message: "Widened the bracket",
      origin: "agent",
      pass: 0,
      files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
      params: {},
      renders: [],
      validation: null,
      annotations: []
    };
    const events: SseEvent[] = [turnStarted(), { type: "snapshot_created", turn_id: TURN_ID, project_id: "p1", snapshot: manifest }];
    const state = reduceChatEvents(events);
    expect(state.items).toHaveLength(0);
    expect(state.headSnapshot).toEqual(manifest);
  });

  it("closes the turn and records a turn_status item on turn_done", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "turn_done", turn_id: TURN_ID, status: "completed", passes_used: 1, summary: "Done.", usage: null, duration_ms: 5000 }
    ];
    const state = reduceChatEvents(events);
    expect(state.activeTurnId).toBeNull();
    expect(state.items[0]).toMatchObject({ kind: "turn_status", status: "completed", summary: "Done." });
  });

  it("counterexample: a mid-turn error event closes the turn and renders visibly, without throwing", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "assistant_text", turn_id: TURN_ID, text: "Working on it…" },
      { type: "error", turn_id: TURN_ID, error_code: "AGENT_ERROR", message: "Upstream provider failed mid-turn." }
    ];
    expect(() => reduceChatEvents(events)).not.toThrow();
    const state = reduceChatEvents(events);
    expect(state.activeTurnId).toBeNull();
    expect(state.items.at(-1)).toMatchObject({ kind: "error", errorCode: "AGENT_ERROR" });
  });

  it("counterexample: an empty event list is a no-op", () => {
    const state = reduceChatEvents([]);
    expect(state).toEqual(initialChatState);
  });

  it("is a pure function: the same state/event pair always reduces identically", () => {
    const event: SseEvent = { type: "assistant_text", turn_id: TURN_ID, text: "hi" };
    const a = reduceChatEvent(initialChatState, event);
    const b = reduceChatEvent(initialChatState, event);
    expect(a).toEqual(b);
    expect(initialChatState.items).toHaveLength(0); // original state untouched
  });
});

// ── the user's own message (Issue #41 symptom 2) ─────────────────────────────
//
// The frozen SSE union is assistant-side only, so nothing ever echoed the
// user's prompt into the transcript and the demo read as a monologue.

describe("reduceChatAction — local user echo", () => {
  it("appends the user's message as its own transcript item", () => {
    const state = reduceChatAction(initialChatState, {
      type: "local_user_message",
      localId: "local-1",
      text: "Make me a hinged box"
    });
    expect(state.items).toEqual([{ kind: "user_text", localId: "local-1", text: "Make me a hinged box" }]);
  });

  it("is idempotent for the same localId — a re-dispatch never duplicates the prompt (AC)", () => {
    const action = { type: "local_user_message" as const, localId: "local-1", text: "Make me a hinged box" };
    const once = reduceChatAction(initialChatState, action);
    const twice = reduceChatAction(once, action);
    expect(twice.items).toHaveLength(1);
    // Identity, not just length: an idempotent action must not churn state and
    // force React to re-render the whole transcript.
    expect(twice).toBe(once);
  });

  it("keeps two distinct prompts, even when their text is identical", () => {
    let state = reduceChatAction(initialChatState, { type: "local_user_message", localId: "local-1", text: "again" });
    state = reduceChatAction(state, { type: "local_user_message", localId: "local-2", text: "again" });
    expect(state.items).toHaveLength(2);
  });

  it("the echo survives the rest of the turn's events, in submission order (AC)", () => {
    // The regression this pins: the prompt must still be there, above the
    // reply, once the whole turn has streamed in.
    let state = reduceChatAction(initialChatState, {
      type: "local_user_message",
      localId: "local-1",
      text: "Make me a hinged box"
    });
    const events: SseEvent[] = [
      turnStarted(),
      { type: "assistant_text", turn_id: TURN_ID, text: "Done." },
      {
        type: "turn_done",
        turn_id: TURN_ID,
        status: "ok",
        passes_used: 1,
        summary: "Built it",
        usage: null,
        duration_ms: 10
      }
    ];
    for (const event of events) state = reduceChatAction(state, event);

    expect(state.items[0]).toMatchObject({ kind: "user_text", text: "Make me a hinged box" });
    expect(state.items.some((item) => item.kind === "assistant_text")).toBe(true);
  });

  it("restores a stored transcript wholesale, and reset clears it", () => {
    const items: ChatItem[] = [{ kind: "user_text", localId: "local-1", text: "restored" }];
    const restored = reduceChatAction(initialChatState, { type: "local_restore", items });
    expect(restored.items).toEqual(items);

    // Re-echoing a restored message (the same localId arriving again after a
    // rehydrate) still must not duplicate it.
    const reEchoed = reduceChatAction(restored, {
      type: "local_user_message",
      localId: "local-1",
      text: "restored"
    });
    expect(reEchoed.items).toHaveLength(1);

    expect(reduceChatAction(restored, { type: "local_reset" })).toEqual(initialChatState);
  });
});
