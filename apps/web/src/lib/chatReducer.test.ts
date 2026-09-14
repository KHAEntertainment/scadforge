import { describe, expect, it } from "vitest";
import type { SnapshotManifest, SseEvent } from "@scadforge/protocol";
import { initialChatState, reduceChatAction, reduceChatEvent, reduceChatEvents } from "./chatReducer.js";
import type { ChatItem } from "./chatReducer.js";

const TURN_ID = "turn-1";

function turnStarted(): SseEvent {
  return { type: "turn_started", turn_id: TURN_ID, project_id: "p1", max_passes: 2, started_at: "2026-08-26T00:00:00.000Z" };
}

function assistantTextItems(items: ChatItem[]): Extract<ChatItem, { kind: "assistant_text" }>[] {
  return items.filter((item): item is Extract<ChatItem, { kind: "assistant_text" }> => item.kind === "assistant_text");
}

describe("reduceChatEvents", () => {
  it("accumulates consecutive assistant_text chunks into one growing item", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "assistant_text", turn_id: TURN_ID, text: "Building " },
      { type: "assistant_text", turn_id: TURN_ID, text: "a bracket." }
    ];
    const state = reduceChatEvents(events);
    const assistantItems = assistantTextItems(state.items);
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toMatchObject({ kind: "assistant_text", text: "Building a bracket." });
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
    const toolItems = state.items.filter((item) => item.kind === "tool_activity");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]).toMatchObject({
      kind: "tool_activity",
      name: "render_views",
      status: "ok",
      summary: "Rendered 2 views"
    });
    // Counterexample guard: nothing resembling a full envelope/payload dump.
    expect(JSON.stringify(toolItems[0])).not.toContain("bytes");
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
    const toolItem = state.items.find((item) => item.kind === "tool_activity");
    expect(toolItem).toMatchObject({ kind: "tool_activity", status: "failed", summary: "Syntax error on line 4" });
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
    // Only the running placeholder from turn_started — snapshot_created still adds no item of its own.
    expect(state.items).toHaveLength(1);
    expect(state.items[0].kind).toBe("turn_running");
    expect(state.headSnapshot).toEqual(manifest);
  });

  it("closes the turn and records a turn_status item on turn_done", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "turn_done", turn_id: TURN_ID, status: "completed", passes_used: 1, summary: "Done.", usage: null, duration_ms: 5000 }
    ];
    const state = reduceChatEvents(events);
    expect(state.activeTurnId).toBeNull();
    // Replaces the running placeholder in place — no leftover turn_running item.
    expect(state.items).toHaveLength(1);
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
    // The error replaces the running placeholder in place (no duplicate items),
    // so it lands where turn_started put the placeholder, not necessarily last.
    const errorItem = state.items.find((item) => item.kind === "error");
    expect(errorItem).toMatchObject({ kind: "error", errorCode: "AGENT_ERROR" });
    expect(state.items.filter((item) => item.kind === "turn_running")).toHaveLength(0);
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

// ── running-turn feedback (Issue #76) ────────────────────────────────────────
//
// `turn_started` used to reduce to `activeTurnId` alone — nothing rendered
// while the model was thinking, which measured ~6 minutes in one real turn.

describe("reduceChatEvents — running-turn placeholder", () => {
  it("turn_started immediately renders a running placeholder, before any tool or text event (AC)", () => {
    const state = reduceChatEvents([turnStarted()]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "turn_running",
      turnId: TURN_ID,
      startedAt: "2026-08-26T00:00:00.000Z",
      phase: "waiting",
      lastToolName: null
    });
    expect(state.activeTurnId).toBe(TURN_ID);
  });

  it("flips to the working phase with the tool name once a tool_call arrives, and keeps the placeholder on top", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "tool_call", turn_id: TURN_ID, tool_call_id: "call-1", name: "render_views", pass: 0, input_summary: null }
    ];
    const state = reduceChatEvents(events);
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: "turn_running", phase: "working", lastToolName: "render_views" });
    expect(state.items[1]).toMatchObject({ kind: "tool_activity", name: "render_views" });
  });

  it("flips to the working phase (no tool name) once assistant_text arrives with no prior tool activity", () => {
    const events: SseEvent[] = [turnStarted(), { type: "assistant_text", turn_id: TURN_ID, text: "Thinking…" }];
    const state = reduceChatEvents(events);
    expect(state.items[0]).toMatchObject({ kind: "turn_running", phase: "working", lastToolName: null });
  });

  it("a later tool_result does not clobber a still-more-recent tool_call's name", () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "tool_call", turn_id: TURN_ID, tool_call_id: "call-1", name: "write_scad", pass: 0, input_summary: null },
      {
        type: "tool_result",
        turn_id: TURN_ID,
        tool_call_id: "call-1",
        name: "write_scad",
        pass: 0,
        ok: true,
        error_code: null,
        summary: "Saved",
        artifacts: [],
        duration_ms: 10
      }
    ];
    const state = reduceChatEvents(events);
    expect(state.items[0]).toMatchObject({ kind: "turn_running", phase: "working", lastToolName: "write_scad" });
  });

  it("two turns back to back each get their own running item, with no leftover from the first", () => {
    const first: SseEvent[] = [
      turnStarted(),
      { type: "turn_done", turn_id: TURN_ID, status: "completed", passes_used: 1, summary: "Done.", usage: null, duration_ms: 10 }
    ];
    const afterFirst = reduceChatEvents(first);
    const second: SseEvent = { type: "turn_started", turn_id: "turn-2", project_id: "p1", max_passes: 2, started_at: "2026-08-26T00:05:00.000Z" };
    const state = reduceChatEvent(afterFirst, second);

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: "turn_status", turnId: TURN_ID });
    expect(state.items[1]).toMatchObject({ kind: "turn_running", turnId: "turn-2", phase: "waiting" });
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
        status: "completed",
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

// ── stream-drop reconciliation (Issue #77) ───────────────────────────────────
//
// The server keeps running a turn after the client disconnects (routes/chat.ts
// swallows write failures); these local actions are how `useChat` surfaces
// that gap and later reconciles it, without any new wire event.

describe("reduceChatAction — connection lost / reconciliation", () => {
  function stateAfterTurnStarted(): ReturnType<typeof reduceChatEvent> {
    return reduceChatEvent(initialChatState, turnStarted());
  }

  it("replaces the running placeholder with a connection_lost item and clears activeTurnId", () => {
    const state = reduceChatAction(stateAfterTurnStarted(), { type: "local_connection_lost", turnId: TURN_ID });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "connection_lost", turnId: TURN_ID, status: "lost" });
    expect(state.activeTurnId).toBeNull();
  });

  it("counterexample: with no matching running item, the connection_lost item is still appended (never dropped)", () => {
    const state = reduceChatAction(initialChatState, { type: "local_connection_lost", turnId: "turn-orphan" });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "connection_lost", turnId: "turn-orphan" });
  });

  it("a check-in-flight marks the item checking, and a still-running result flips it back with no new item", () => {
    let state = reduceChatAction(stateAfterTurnStarted(), { type: "local_connection_lost", turnId: TURN_ID });
    state = reduceChatAction(state, { type: "local_connection_check_started" });
    expect(state.items[0]).toMatchObject({ kind: "connection_lost", status: "checking" });

    state = reduceChatAction(state, { type: "local_connection_still_running" });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "connection_lost", status: "still_running" });
  });

  it("an advanced head replaces connection_lost with a reconciled_status item and updates headSnapshot (AC)", () => {
    const manifest: SnapshotManifest = {
      id: "0004",
      parent: "0003",
      timestamp: "2026-09-13T00:00:00.000Z",
      message: "Finished while disconnected",
      origin: "agent",
      pass: 1,
      files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
      params: {},
      renders: [],
      validation: null,
      annotations: []
    };
    let state = reduceChatAction(stateAfterTurnStarted(), { type: "local_connection_lost", turnId: TURN_ID });
    state = reduceChatAction(state, { type: "local_connection_advanced", turnId: TURN_ID, snapshot: manifest });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "reconciled_status", turnId: TURN_ID, headId: "0004" });
    expect(state.headSnapshot).toEqual(manifest);
  });

  it("dismissing removes the connection_lost item and nothing else", () => {
    let state = reduceChatAction(initialChatState, { type: "local_user_message", localId: "local-1", text: "hi" });
    state = reduceChatAction(state, turnStarted());
    state = reduceChatAction(state, { type: "local_connection_lost", turnId: TURN_ID });
    state = reduceChatAction(state, { type: "local_connection_dismissed" });

    expect(state.items).toEqual([{ kind: "user_text", localId: "local-1", text: "hi" }]);
  });
});
