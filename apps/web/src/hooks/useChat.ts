import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ApiClient } from "../lib/apiClient.js";
import {
  reduceChatAction,
  initialChatState,
  type ChatAction,
  type ChatItem,
  type ChatState
} from "../lib/chatReducer.js";
import { parseSseStream } from "../lib/sse.js";

function reducer(state: ChatState, action: ChatAction): ChatState {
  return reduceChatAction(state, action);
}

export interface UseChatResult {
  state: ChatState;
  /** True while a turn's SSE stream is open. */
  isStreaming: boolean;
  /** Set when the stream itself fails (network drop, malformed frame) — distinct from a well-formed `error` SSE event, which lands in `state.items`. */
  streamError: string | null;
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Where a project's transcript is parked so a page refresh does not erase it
 * (Issue #41 AC: the echoed prompt "survives the turn and a refresh").
 *
 * `sessionStorage`, deliberately, on three grounds:
 *   - The server has no transcript resource to reload from. `message.md` holds
 *     the AGENT's one-line summary, not the user's prompt, and adding a
 *     transcript route would mean editing the frozen `packages/protocol`.
 *   - It is neither auth nor a database (PROJECT_CONTEXT.md forbids both) —
 *     just this tab's scratch space.
 *   - Tab-scoped rather than `localStorage` so a transcript cannot outlive the
 *     session it belongs to and reappear, stale, days later.
 */
function storageKey(projectId: string): string {
  return `scadforge:chat:${projectId}`;
}

/**
 * Storage access is wrapped because it genuinely throws in the wild: Safari
 * private mode, and any browser configured to block site data, reject the
 * accessor itself. A transcript we cannot cache is a cosmetic loss and must
 * never take the chat panel down with it.
 */
function loadItems(projectId: string): ChatItem[] | null {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatItem[]) : null;
  } catch {
    return null;
  }
}

function saveItems(projectId: string, items: ChatItem[]): void {
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(items));
  } catch {
    // Quota exceeded or storage blocked — see above.
  }
}

let localMessageCounter = 0;
function nextLocalId(): string {
  localMessageCounter += 1;
  return `local-${Date.now()}-${localMessageCounter}`;
}

/**
 * Drives one project's chat turn lifecycle: opens the SSE stream, folds each
 * frame into {@link ChatState} via the pure reducer, and degrades gracefully
 * (a visible error item, not a crash) if the stream drops mid-turn.
 *
 * Also owns the two client-side transcript concerns the wire cannot cover:
 * echoing the user's own message the moment it is sent, and restoring the
 * transcript after a refresh.
 */
export function useChat(client: ApiClient, projectId: string | null): UseChatResult {
  const [state, dispatch] = useReducer(reducer, initialChatState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Gates persistence until the restore for THIS project has run — see below. */
  const hydratedFor = useRef<string | null>(null);

  // Restore on mount / project switch. This runs before the persistence effect
  // below can fire for the same project, so the initial empty state is never
  // written over a stored transcript.
  useEffect(() => {
    if (!projectId) {
      hydratedFor.current = null;
      dispatch({ type: "local_reset" });
      return;
    }
    const stored = loadItems(projectId);
    dispatch(stored ? { type: "local_restore", items: stored } : { type: "local_reset" });
    hydratedFor.current = projectId;
  }, [projectId]);

  // Persist every transcript change. Keyed by project so switching projects
  // cannot cross-contaminate two transcripts.
  useEffect(() => {
    if (!projectId || hydratedFor.current !== projectId) return;
    saveItems(projectId, state.items);
  }, [projectId, state.items]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!projectId || text.trim().length === 0) return;

      // Echo FIRST, before any await. The prompt has to appear on the very
      // next paint — not after the request resolves, and not conditionally on
      // it succeeding, since a failed turn is exactly when the user most needs
      // to see what they asked for (Issue #41 symptom 2).
      dispatch({ type: "local_user_message", localId: nextLocalId(), text });

      setStreamError(null);
      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await client.openChatStream(projectId, { message: text }, controller.signal);
        if (!response.body) {
          throw new Error("Chat response had no body");
        }
        for await (const event of parseSseStream(response.body, controller.signal)) {
          dispatch(event);
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : "Chat stream failed unexpectedly.";
        setStreamError(message);
      } finally {
        setIsStreaming(false);
      }
    },
    [client, projectId]
  );

  return { state, isStreaming, streamError, sendMessage };
}
