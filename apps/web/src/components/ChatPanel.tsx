import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatItem, ChatState } from "../lib/chatReducer.js";

export interface ChatPanelProps {
  state: ChatState;
  isStreaming: boolean;
  streamError: string | null;
  onSend: (text: string) => void;
  disabled?: boolean;
}

/** `m:ss`, per Issue #76 AC — minutes unpadded, seconds zero-padded. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function phaseLabel(item: Extract<ChatItem, { kind: "turn_running" }>): string {
  if (item.phase === "waiting") return "Waiting for the model";
  return item.lastToolName ? `Working — ${item.lastToolName}` : "Working";
}

function ChatItemRow({ item, now }: { item: ChatItem; now: number }) {
  switch (item.kind) {
    case "user_text":
      return (
        <p className="chat-item chat-item--user" data-testid="chat-user-message">
          {item.text}
        </p>
      );

    case "assistant_text":
      return <p className="chat-item chat-item--assistant">{item.text}</p>;

    case "tool_activity":
      // Compact, no raw payload dumps (Issue #18 AC): tool name, pass, status
      // pill, and the short summary once the result lands.
      return (
        <div className="chat-item chat-item--tool" data-testid="tool-activity">
          <span className={`tool-status tool-status--${item.status}`}>{item.status}</span>
          <span className="tool-name">{item.name}</span>
          <span className="tool-pass">pass {item.pass}</span>
          {item.summary ? <span className="tool-summary">{item.summary}</span> : null}
        </div>
      );

    case "turn_status":
      return (
        <p className={`chat-item chat-item--turn-status turn-status--${item.status}`}>
          {item.summary ?? `Turn ${item.status}`}
        </p>
      );

    case "turn_running":
      // Reuses `.chat-item--turn-status` styling with a `--running` modifier
      // (Issue #76 AC) — no motion beyond the text itself, so reduced-motion
      // users see the same thing.
      return (
        <div className="chat-item chat-item--turn-status chat-item--turn-status--running" data-testid="turn-running">
          <span className="turn-running-phase">{phaseLabel(item)}</span>
          <span className="turn-running-elapsed">{formatElapsed(now - Date.parse(item.startedAt))}</span>
        </div>
      );

    case "error":
      return (
        <p className="chat-item chat-item--error" role="alert">
          {item.errorCode}: {item.message}
        </p>
      );

    default:
      return null;
  }
}

export function ChatPanel({ state, isStreaming, streamError, onSend, disabled }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const hasRunningTurn = state.items.some((item) => item.kind === "turn_running");

  // 1×/sec elapsed-time tick for the running-turn item (Issue #76 AC): a
  // self-rearming `setTimeout` rather than `setInterval`, matching this
  // codebase's existing timer convention (see `useParamsController`'s debounce).
  // Re-running whenever `now` changes re-arms the next tick; the effect is
  // scoped to whether a running item exists at all, so the timer from one
  // turn is always cleared before the next turn's begins — no leaks across
  // back-to-back turns, and none left running after unmount.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunningTurn) return;
    const id = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(id);
  }, [hasRunningTurn, now]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim().length === 0) return;
    onSend(draft);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="chat-panel" aria-label="Chat conversation">
      <div className="chat-transcript" data-testid="chat-transcript">
        {state.items.length === 0 ? (
          <p className="chat-empty">Ask ScadForge to build or change your model.</p>
        ) : (
          state.items.map((item, index) => <ChatItemRow key={index} item={item} now={now} />)
        )}
        {streamError ? (
          <p className="chat-item chat-item--error" role="alert" data-testid="chat-stream-error">
            The chat stream disconnected: {streamError}
          </p>
        ) : null}
      </div>
      <form className="chat-composer" onSubmit={handleSubmit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to build…"
          disabled={disabled || isStreaming}
          aria-label="Message"
          rows={3}
        />
        <button type="submit" disabled={disabled || isStreaming || draft.trim().length === 0}>
          {isStreaming ? "Working…" : "Send ⌘↵"}
        </button>
      </form>
    </section>
  );
}
