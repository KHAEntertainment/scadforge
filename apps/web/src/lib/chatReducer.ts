// Reduces the frozen SSE event union into chat-transcript state.
//
// Kept as a pure function (`reduceChatEvent`) independent of React so it can
// be unit-tested directly against scripted event sequences (Issue #18 AC:
// "component tests for chat event reduction").

import type { SnapshotManifest, SseEvent, TurnStatus, TurnUsage } from "@scadforge/protocol";

/** One row in the rendered chat transcript. */
export type ChatItem =
  | { kind: "assistant_text"; turnId: string; text: string }
  | {
      kind: "tool_activity";
      turnId: string;
      toolCallId: string;
      name: string;
      pass: number;
      /** `"running"` until the matching `tool_result` arrives. */
      status: "running" | "ok" | "failed";
      summary: string | null;
      inputSummary: string | null;
    }
  | { kind: "turn_status"; turnId: string; status: TurnStatus; summary: string | null; usage: TurnUsage | null }
  | { kind: "error"; turnId: string | null; errorCode: string; message: string };

export interface ChatState {
  items: ChatItem[];
  /** The turn currently streaming; null once `turn_done`/`error` closes it. */
  activeTurnId: string | null;
  /** Newest snapshot seen via `snapshot_created`, for the Preview/status strip. */
  headSnapshot: SnapshotManifest | null;
  /**
   * URL of the most recent `kind: "mesh"` `ToolArtifact` surfaced by a
   * `tool_result` (e.g. `render_views`/`validate_mesh`), for the three.js
   * viewer. `null` until a turn has produced one.
   */
  latestMeshUrl: string | null;
}

export const initialChatState: ChatState = {
  items: [],
  activeTurnId: null,
  headSnapshot: null,
  latestMeshUrl: null
};

function updateLast<T extends ChatItem>(
  items: ChatItem[],
  predicate: (item: ChatItem) => item is T,
  update: (item: T) => T
): ChatItem[] | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (predicate(item)) {
      const next = items.slice();
      next[i] = update(item);
      return next;
    }
  }
  return null;
}

/** Applies one SSE event to chat state. Never throws on well-typed input. */
export function reduceChatEvent(state: ChatState, event: SseEvent): ChatState {
  switch (event.type) {
    case "turn_started": {
      return { ...state, activeTurnId: event.turn_id };
    }

    case "tool_call": {
      const item: ChatItem = {
        kind: "tool_activity",
        turnId: event.turn_id,
        toolCallId: event.tool_call_id,
        name: event.name,
        pass: event.pass,
        status: "running",
        summary: null,
        inputSummary: event.input_summary
      };
      return { ...state, items: [...state.items, item] };
    }

    case "tool_result": {
      const updated = updateLast(
        state.items,
        (item): item is Extract<ChatItem, { kind: "tool_activity" }> =>
          item.kind === "tool_activity" && item.toolCallId === event.tool_call_id,
        (item) => ({
          ...item,
          status: event.ok ? "ok" : "failed",
          summary: event.summary
        })
      );
      const meshArtifact = event.artifacts.find((artifact) => artifact.kind === "mesh");
      return {
        ...state,
        items: updated ?? state.items,
        latestMeshUrl: meshArtifact ? meshArtifact.url : state.latestMeshUrl
      };
    }

    case "assistant_text": {
      // Coalesce consecutive assistant_text chunks in the same turn into one
      // growing item so prose renders progressively rather than as separate
      // bubbles per SSE frame.
      const updated = updateLast(
        state.items,
        (item): item is Extract<ChatItem, { kind: "assistant_text" }> =>
          item.kind === "assistant_text" && item.turnId === event.turn_id,
        (item) => ({ ...item, text: item.text + event.text })
      );
      if (updated) return { ...state, items: updated };
      return {
        ...state,
        items: [...state.items, { kind: "assistant_text", turnId: event.turn_id, text: event.text }]
      };
    }

    case "snapshot_created": {
      // No transcript item — the snapshot list (separate `GET /snapshots`
      // fetch) is the source of truth for History. We do track it as the
      // new head for the status strip / preview, since it arrives live.
      return { ...state, headSnapshot: event.snapshot };
    }

    case "turn_done": {
      const item: ChatItem = {
        kind: "turn_status",
        turnId: event.turn_id,
        status: event.status,
        summary: event.summary,
        usage: event.usage
      };
      return { ...state, items: [...state.items, item], activeTurnId: null };
    }

    case "error": {
      const item: ChatItem = {
        kind: "error",
        turnId: event.turn_id,
        errorCode: event.error_code,
        message: event.message
      };
      return { ...state, items: [...state.items, item], activeTurnId: null };
    }

    default: {
      // Exhaustiveness guard: if the frozen union grows, this fails to build.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Folds an ordered list of events (e.g. from a test fixture) into final state. */
export function reduceChatEvents(events: SseEvent[], seed: ChatState = initialChatState): ChatState {
  return events.reduce(reduceChatEvent, seed);
}
