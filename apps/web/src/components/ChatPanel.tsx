import { useState, type FormEvent } from "react";
import type { ChatItem, ChatState } from "../lib/chatReducer.js";

export interface ChatPanelProps {
  state: ChatState;
  isStreaming: boolean;
  streamError: string | null;
  onSend: (text: string) => void;
  disabled?: boolean;
}

function ChatItemRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim().length === 0) return;
    onSend(draft);
    setDraft("");
  }

  return (
    <section className="chat-panel" aria-label="Chat">
      <div className="chat-transcript" data-testid="chat-transcript">
        {state.items.length === 0 ? (
          <p className="chat-empty">Ask ScadForge to build or change your model.</p>
        ) : (
          state.items.map((item, index) => <ChatItemRow key={index} item={item} />)
        )}
        {streamError ? (
          <p className="chat-item chat-item--error" role="alert" data-testid="chat-stream-error">
            The chat stream disconnected: {streamError}
          </p>
        ) : null}
      </div>
      <form className="chat-composer" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Describe what you want to build…"
          disabled={disabled || isStreaming}
          aria-label="Message"
        />
        <button type="submit" disabled={disabled || isStreaming || draft.trim().length === 0}>
          {isStreaming ? "Working…" : "Send"}
        </button>
      </form>
    </section>
  );
}
