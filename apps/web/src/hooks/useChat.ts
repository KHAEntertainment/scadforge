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

/**
 * Fixed copy for a dropped mid-turn stream (Issue #77 AC). Deliberately the
 * same text regardless of whether the stream body simply ended or the fetch
 * itself rejected — from the user's point of view both mean the same thing:
 * the turn may still be running server-side (`routes/chat.ts` continues a
 * turn past client disconnect) and needs reconciling, not just an error.
 */
const CONNECTION_LOST_MESSAGE = "Connection to the studio server was lost while the turn was running.";

/** Never re-check more often than this (Issue #77 AC: "do not poll faster than every 5s"). */
const CHECK_MIN_INTERVAL_MS = 5000;

function isConnectionLostItem(item: ChatItem): item is Extract<ChatItem, { kind: "connection_lost" }> {
  return item.kind === "connection_lost";
}

/**
 * The turn's head baseline, or the fact that it could not be determined.
 * `ok: false` must never be treated as "no snapshot existed" — it means
 * "unknown", and `checkConnectionResult` must not compare against it as if
 * it were a real id (a null-as-baseline bug would make ANY current head look
 * "advanced", painting a false reconciled result).
 */
type BaselineResult = { ok: true; id: string | null } | { ok: false };

function fetchBaseline(client: ApiClient, projectId: string): Promise<BaselineResult> {
  return client.getProject(projectId).then(
    (res): BaselineResult => ({ ok: true, id: res.head?.id ?? null }),
    (): BaselineResult => ({ ok: false })
  );
}

export interface UseChatResult {
  state: ChatState;
  /** True while a turn's SSE stream is open. */
  isStreaming: boolean;
  /** Set when the stream itself fails (network drop, malformed frame) — distinct from a well-formed `error` SSE event, which lands in `state.items`. */
  streamError: string | null;
  sendMessage: (text: string) => Promise<void>;
  /**
   * Re-fetches the project head and, if it advanced past the baseline
   * recorded at `turn_started`, reconciles the `connection_lost` item into a
   * `reconciled_status` item (Issue #77 AC). Throttled to at most once per
   * {@link CHECK_MIN_INTERVAL_MS}; a no-op when no `connection_lost` item is
   * present.
   */
  checkConnectionResult: () => Promise<void>;
  /** Clears a `connection_lost` item, re-enabling `sendMessage` (Issue #77 AC). */
  dismissConnectionLost: () => void;
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
  const projectGenerationRef = useRef(0);
  /** Gates persistence until the restore for THIS project has run — see below. */
  const hydratedFor = useRef<string | null>(null);
  /**
   * Mirrors `state` for callbacks that must read the LATEST transcript
   * (`checkConnectionResult`, the focus/visibility auto-check) without
   * retriggering `useCallback`/`useEffect` on every dispatch.
   */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  /**
   * The project's head snapshot id as of `turn_started`, fetched fresh via
   * `GET /projects/:id` rather than read from `state.headSnapshot` (Issue #77):
   * that field is empty right after a restore/refresh even though the server
   * has real history, which would make ANY existing head look "advanced".
   * `null` (not a pending/resolved promise) means no turn has started yet —
   * `checkConnectionResult` treats that the same as an unresolved baseline.
   */
  const startedHeadPromiseRef = useRef<Promise<BaselineResult> | null>(null);
  /** Issue #77 AC: never re-check more often than {@link CHECK_MIN_INTERVAL_MS}. */
  const lastCheckAtRef = useRef(0);
  /** The `connection_lost` turnId already auto-checked once via focus/visibilitychange. */
  const autoCheckedTurnRef = useRef<string | null>(null);

  // Restore on mount / project switch. This runs before the persistence effect
  // below can fire for the same project, so the initial empty state is never
  // written over a stored transcript.
  useEffect(() => {
    const generation = ++projectGenerationRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setStreamError(null);
    startedHeadPromiseRef.current = null;
    lastCheckAtRef.current = 0;
    autoCheckedTurnRef.current = null;
    if (!projectId) {
      hydratedFor.current = null;
      dispatch({ type: "local_reset" });
      return;
    }
    const stored = loadItems(projectId);
    dispatch(stored ? { type: "local_restore", items: stored } : { type: "local_reset" });
    hydratedFor.current = projectId;
    return () => {
      // Abort and invalidate any stream belonging to the project being left.
      if (projectGenerationRef.current === generation) {
        projectGenerationRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        // Belt-and-suspenders alongside the generation guards in sendMessage/
        // checkConnectionResult: a baseline fetch or reconciliation still in
        // flight for the project being left must never write into what the
        // next project's turn will read as its own baseline.
        startedHeadPromiseRef.current = null;
      }
    };
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
      // Issue #77 AC: a user cannot send while a connection_lost item is
      // unresolved. `ChatPanel` already guards this at the UI layer; this is
      // defense in depth against a caller that skips it.
      if (stateRef.current.items.some(isConnectionLostItem)) return;
      const generation = projectGenerationRef.current;

      // Echo FIRST, before any await. The prompt has to appear on the very
      // next paint — not after the request resolves, and not conditionally on
      // it succeeding, since a failed turn is exactly when the user most needs
      // to see what they asked for (Issue #41 symptom 2).
      dispatch({ type: "local_user_message", localId: nextLocalId(), text });

      setStreamError(null);
      setIsStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      // Tracks whether this fetch ever saw its turn open, and whether it was
      // ever closed by a well-formed turn_done/error (Issue #77): a stream
      // that ends or a fetch that rejects WITHOUT the latter, after having
      // seen the former, is a dropped connection, not a normal completion.
      let turnId: string | null = null;
      let turnClosed = false;
      try {
        const response = await client.openChatStream(projectId, { message: text }, controller.signal);
        if (!response.body) {
          throw new Error("Chat response had no body");
        }
        for await (const event of parseSseStream(response.body, controller.signal)) {
          if (generation !== projectGenerationRef.current) return;
          if (event.type === "turn_started") {
            turnId = event.turn_id;
            // Fire-and-forget: the baseline only needs to be ready by the time
            // a reconciliation check runs, never before the next SSE frame.
            startedHeadPromiseRef.current = fetchBaseline(client, projectId);
          } else if (event.type === "turn_done" || event.type === "error") {
            turnClosed = true;
          }
          dispatch(event);
        }
        // The stream ended (generator returned) with no exception. A
        // deliberate abort (project switch) also ends the loop this way —
        // exclude it, since that is expected and already handled.
        if (controller.signal.aborted || generation !== projectGenerationRef.current) return;
        if (turnId && !turnClosed) {
          dispatch({ type: "local_connection_lost", turnId });
          setStreamError(CONNECTION_LOST_MESSAGE);
        }
      } catch (cause) {
        if (controller.signal.aborted || generation !== projectGenerationRef.current) return;
        if (turnId && !turnClosed) {
          dispatch({ type: "local_connection_lost", turnId });
        }
        const message = cause instanceof Error ? cause.message : "Chat stream failed unexpectedly.";
        setStreamError(message);
      } finally {
        if (generation === projectGenerationRef.current) setIsStreaming(false);
      }
    },
    [client, projectId]
  );

  const checkConnectionResult = useCallback(async () => {
    if (!projectId) return;
    // Captured now, checked after every await below: a stale check for a
    // project the user has since switched away from must never dispatch into
    // the fresh project's state (it would corrupt a just-reset transcript
    // with another project's head/turn id).
    const generation = projectGenerationRef.current;
    const lostItem = stateRef.current.items.find(isConnectionLostItem);
    if (!lostItem) return;
    const now = Date.now();
    if (now - lastCheckAtRef.current < CHECK_MIN_INTERVAL_MS) return;
    lastCheckAtRef.current = now;

    dispatch({ type: "local_connection_check_started" });
    try {
      let baseline = await (startedHeadPromiseRef.current ?? Promise.resolve<BaselineResult>({ ok: false }));
      if (generation !== projectGenerationRef.current) return;
      if (!baseline.ok) {
        // The turn_started baseline fetch never resolved successfully —
        // retry it now. An unknown baseline must never be treated as "no
        // prior head": that would make ANY current head look "advanced" and
        // paint a false reconciled result.
        baseline = await fetchBaseline(client, projectId);
        if (generation !== projectGenerationRef.current) return;
        if (baseline.ok) startedHeadPromiseRef.current = Promise.resolve(baseline);
      }
      if (!baseline.ok) {
        // Still can't establish a baseline (server unreachable) — stay
        // retryable rather than guess.
        dispatch({ type: "local_connection_still_running" });
        return;
      }
      const projectRes = await client.getProject(projectId);
      if (generation !== projectGenerationRef.current) return;
      const newHead = projectRes.head;
      if (newHead && newHead.id !== baseline.id) {
        dispatch({ type: "local_connection_advanced", turnId: lostItem.turnId, snapshot: newHead });
      } else {
        dispatch({ type: "local_connection_still_running" });
      }
    } catch {
      if (generation !== projectGenerationRef.current) return;
      // The server is still unreachable — stay in the retryable state rather
      // than claiming a (possibly wrong) resolution.
      dispatch({ type: "local_connection_still_running" });
    }
  }, [client, projectId]);

  const dismissConnectionLost = useCallback(() => {
    // Scoped to the specific item's turnId (chatReducer AC): dismissing one
    // lost turn's item must never clear a different turn's.
    const lostItem = stateRef.current.items.find(isConnectionLostItem);
    if (!lostItem) return;
    dispatch({ type: "local_connection_dismissed", turnId: lostItem.turnId });
  }, []);

  // Issue #77 AC: reconcile automatically, once per lost turn, the moment the
  // tab is revived — the exact scenario that produced the bug (a backgrounded
  // tab whose fetch died silently).
  useEffect(() => {
    function autoCheck() {
      const lostItem = stateRef.current.items.find(isConnectionLostItem);
      if (!lostItem || autoCheckedTurnRef.current === lostItem.turnId) return;
      autoCheckedTurnRef.current = lostItem.turnId;
      void checkConnectionResult();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") autoCheck();
    }
    window.addEventListener("focus", autoCheck);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", autoCheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkConnectionResult]);

  return { state, isStreaming, streamError, sendMessage, checkConnectionResult, dismissConnectionLost };
}
