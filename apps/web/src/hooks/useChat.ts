import { useCallback, useReducer, useRef, useState } from "react";
import type { SseEvent } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";
import { reduceChatEvent, initialChatState, type ChatState } from "../lib/chatReducer.js";
import { parseSseStream } from "../lib/sse.js";

function reducer(state: ChatState, event: SseEvent): ChatState {
  return reduceChatEvent(state, event);
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
 * Drives one project's chat turn lifecycle: opens the SSE stream, folds each
 * frame into {@link ChatState} via the pure reducer, and degrades gracefully
 * (a visible error item, not a crash) if the stream drops mid-turn.
 */
export function useChat(client: ApiClient, projectId: string | null): UseChatResult {
  const [state, dispatch] = useReducer(reducer, initialChatState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!projectId || text.trim().length === 0) return;
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
