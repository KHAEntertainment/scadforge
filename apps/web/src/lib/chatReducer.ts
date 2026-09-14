// Reduces the frozen SSE event union into chat-transcript state.
//
// Kept as a pure function (`reduceChatEvent`) independent of React so it can
// be unit-tested directly against scripted event sequences (Issue #18 AC:
// "component tests for chat event reduction").

import type { SnapshotManifest, SseEvent, TurnStatus, TurnUsage } from "@scadforge/protocol";

/** One row in the rendered chat transcript. */
export type ChatItem =
  /**
   * The user's own prompt, echoed into the transcript the instant it is
   * submitted (Issue #41 symptom 2).
   *
   * There is no SSE event carrying it back — the frozen event union is
   * assistant-side only — so nothing ever put the user's words on screen and
   * the transcript read as a monologue. `localId` is assigned once at submit
   * time and never regenerated, which is what makes re-rendering, the rest of
   * the turn's events, and a rehydrate-from-storage all idempotent.
   */
  | { kind: "user_text"; localId: string; text: string }
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
  | { kind: "error"; turnId: string | null; errorCode: string; message: string }
  /**
   * Live placeholder for a turn in flight (Issue #76). Pushed the instant
   * `turn_started` is reduced — before any tool or text event exists to render
   * — and replaced IN PLACE (never left alongside a second item) once the turn
   * closes via `turn_done` or `error`. `phase`/`lastToolName` let the UI show
   * "Waiting for the model" vs. "Working — <tool>" without polling; the
   * elapsed-time ticking itself is presentation-only and lives in `ChatPanel`.
   */
  | {
      kind: "turn_running";
      turnId: string;
      /** Echoes `TurnStartedEvent.started_at` — the elapsed-timer epoch. */
      startedAt: string;
      phase: "waiting" | "working";
      lastToolName: string | null;
    };

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

/** Finds the last item matching `predicate` and maps it to a (possibly differently-kinded) replacement. */
function replaceLast<T extends ChatItem>(
  items: ChatItem[],
  predicate: (item: ChatItem) => item is T,
  replacement: (item: T) => ChatItem
): ChatItem[] | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (predicate(item)) {
      const next = items.slice();
      next[i] = replacement(item);
      return next;
    }
  }
  return null;
}

/** `replaceLast` specialised to an in-kind update (the replacement stays the same `ChatItem` variant). */
function updateLast<T extends ChatItem>(
  items: ChatItem[],
  predicate: (item: ChatItem) => item is T,
  update: (item: T) => T
): ChatItem[] | null {
  return replaceLast(items, predicate, update);
}

function isTurnRunning(turnId: string): (item: ChatItem) => item is Extract<ChatItem, { kind: "turn_running" }> {
  return (item): item is Extract<ChatItem, { kind: "turn_running" }> =>
    item.kind === "turn_running" && item.turnId === turnId;
}

/**
 * Marks the in-flight turn's running item "working" once real activity starts
 * (Issue #76 AC: "Waiting for the model" until the first `assistant_text`,
 * `tool_call`, or `tool_result"; then "Working" with the last tool name).
 * `toolName` is null for `assistant_text`, which flips the phase but has no
 * tool to attribute.
 */
function markTurnWorking(items: ChatItem[], turnId: string, toolName: string | null): ChatItem[] | null {
  return updateLast(items, isTurnRunning(turnId), (item) => ({
    ...item,
    phase: "working",
    lastToolName: toolName ?? item.lastToolName
  }));
}

/** Applies one SSE event to chat state. Never throws on well-typed input. */
export function reduceChatEvent(state: ChatState, event: SseEvent): ChatState {
  switch (event.type) {
    case "turn_started": {
      // Issue #76: render feedback the instant the turn opens, not after
      // whatever comes first (a model turn measured at ~6 minutes had nothing
      // on screen until then).
      const item: ChatItem = {
        kind: "turn_running",
        turnId: event.turn_id,
        startedAt: event.started_at,
        phase: "waiting",
        lastToolName: null
      };
      return { ...state, activeTurnId: event.turn_id, items: [...state.items, item] };
    }

    case "tool_call": {
      const withRunning = markTurnWorking(state.items, event.turn_id, event.name) ?? state.items;
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
      return { ...state, items: [...withRunning, item] };
    }

    case "tool_result": {
      const withRunning = markTurnWorking(state.items, event.turn_id, event.name) ?? state.items;
      const updated = updateLast(
        withRunning,
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
        items: updated ?? withRunning,
        latestMeshUrl: meshArtifact ? meshArtifact.url : state.latestMeshUrl
      };
    }

    case "assistant_text": {
      const withRunning = markTurnWorking(state.items, event.turn_id, null) ?? state.items;
      // Coalesce consecutive assistant_text chunks in the same turn into one
      // growing item so prose renders progressively rather than as separate
      // bubbles per SSE frame.
      const updated = updateLast(
        withRunning,
        (item): item is Extract<ChatItem, { kind: "assistant_text" }> =>
          item.kind === "assistant_text" && item.turnId === event.turn_id,
        (item) => ({ ...item, text: item.text + event.text })
      );
      if (updated) return { ...state, items: updated };
      return {
        ...state,
        items: [...withRunning, { kind: "assistant_text", turnId: event.turn_id, text: event.text }]
      };
    }

    case "snapshot_created": {
      // No transcript item — the snapshot list (separate `GET /snapshots`
      // fetch) is the source of truth for History. We do track it as the
      // new head for the status strip / preview, since it arrives live.
      return { ...state, headSnapshot: event.snapshot };
    }

    case "turn_done": {
      // Replaces the turn's `turn_running` item in place (Issue #76 AC): the
      // elapsed-timer placeholder never lingers alongside its own terminal
      // status.
      const item: ChatItem = {
        kind: "turn_status",
        turnId: event.turn_id,
        status: event.status,
        summary: event.summary,
        usage: event.usage
      };
      const replaced = replaceLast(state.items, isTurnRunning(event.turn_id), () => item);
      return { ...state, items: replaced ?? [...state.items, item], activeTurnId: null };
    }

    case "error": {
      const item: ChatItem = {
        kind: "error",
        turnId: event.turn_id,
        errorCode: event.error_code,
        message: event.message
      };
      // A turn_id-less error (e.g. before any turn opened) has no running
      // item to convert; append as before.
      const replaced = event.turn_id ? replaceLast(state.items, isTurnRunning(event.turn_id), () => item) : null;
      return { ...state, items: replaced ?? [...state.items, item], activeTurnId: null };
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

// ── local actions (Issue #41) ────────────────────────────────────────────────
//
// Not everything in the transcript comes from the wire. The user's own message
// and a rehydrated transcript are both purely client-side, so they travel as
// LOCAL actions alongside the frozen `SseEvent` union rather than being faked
// into it — `reduceChatEvent` above stays a pure function of the contract, and
// its exhaustiveness guard keeps working if the union grows.

/** A client-originated transcript change. */
export type ChatLocalAction =
  /** The user submitted `text`; echo it immediately (optimistic). */
  | { type: "local_user_message"; localId: string; text: string }
  /** Replace the whole transcript, e.g. rehydrating after a page refresh. */
  | { type: "local_restore"; items: ChatItem[] }
  /** Drop the transcript, e.g. when the selected project changes. */
  | { type: "local_reset" };

/** Everything `useChat`'s reducer accepts: wire events plus local actions. */
export type ChatAction = SseEvent | ChatLocalAction;

function isLocalAction(action: ChatAction): action is ChatLocalAction {
  return action.type.startsWith("local_");
}

/** Applies one wire event or local action to chat state. Never throws on well-typed input. */
export function reduceChatAction(state: ChatState, action: ChatAction): ChatState {
  if (!isLocalAction(action)) return reduceChatEvent(state, action);

  switch (action.type) {
    case "local_user_message": {
      // Idempotent by `localId`: a double-submit, a StrictMode double-invoke,
      // or a restore racing a live echo can each deliver this twice, and none
      // of them may put the prompt on screen twice (AC: "without
      // duplicating").
      if (state.items.some((item) => item.kind === "user_text" && item.localId === action.localId)) {
        return state;
      }
      return {
        ...state,
        items: [...state.items, { kind: "user_text", localId: action.localId, text: action.text }]
      };
    }

    case "local_restore": {
      return { ...state, items: action.items };
    }

    case "local_reset": {
      return initialChatState;
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
