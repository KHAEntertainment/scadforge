import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { CodeIcon, EyeOpenIcon, ClockIcon, ChatBubbleIcon, MixerHorizontalIcon } from "@radix-ui/react-icons";

export type WorkspaceTab = "chat" | "params" | "code" | "history";

export interface WorkspaceProps {
  preview: ReactNode;
  chat: ReactNode;
  params: ReactNode;
  code: ReactNode;
  history: ReactNode;
  initialWidth?: number;
  onWidthChange?: (width: number) => void;
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const WIDTH_KEY = "scadforge:workspace-width";
const TAB_KEY = "scadforge:workspace-tab";

function readNumber(key: string, fallback: number): number {
  try {
    const value = Number(sessionStorage.getItem(key));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
}

function readTab(): WorkspaceTab {
  try {
    const value = sessionStorage.getItem(TAB_KEY);
    return value === "chat" || value === "params" || value === "code" || value === "history" ? value : "chat";
  } catch {
    return "chat";
  }
}

export function Workspace({ preview, chat, params, code, history, initialWidth = 400, onWidthChange }: WorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>(readTab);
  const [width, setWidth] = useState(() => clampWidth(readNumber(WIDTH_KEY, initialWidth)));
  const draggingRef = useRef(false);

  useEffect(() => {
    try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* optional persistence */ }
  }, [tab]);

  function updateWidth(next: number) {
    const clamped = clampWidth(next);
    setWidth(clamped);
    onWidthChange?.(clamped);
    try { sessionStorage.setItem(WIDTH_KEY, String(clamped)); } catch { /* optional persistence */ }
  }

  function beginResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    if (draggingRef.current) updateWidth(event.clientX);
  }

  function endResize(event: PointerEvent<HTMLButtonElement>) {
    draggingRef.current = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
  }

  function keyResize(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      updateWidth(width - 16);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      updateWidth(width + 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      updateWidth(MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      updateWidth(MAX_WIDTH);
    }
  }

  const panels: Record<WorkspaceTab, ReactNode> = { chat, params, code, history };
  const tabs: Array<{ id: WorkspaceTab; label: string; icon: ReactNode }> = [
    { id: "chat", label: "Chat", icon: <ChatBubbleIcon /> },
    { id: "params", label: "Parameters", icon: <MixerHorizontalIcon /> },
    { id: "code", label: "Code", icon: <CodeIcon /> },
    { id: "history", label: "History", icon: <ClockIcon /> }
  ];

  return (
    <section className="workspace" aria-label="Workspace" style={{ "--tools-width": `${width}px` } as CSSProperties}>
      <aside className="workspace-tools" aria-label="Studio tools">
        <div className="workspace-tabs" role="tablist" aria-label="Studio tools">
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-label={item.id === "params" ? "Params" : undefined} id={`workspace-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`workspace-panel-${item.id}`} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="workspace-panel" role="tabpanel" id={`workspace-panel-${tab}`} aria-labelledby={`workspace-tab-${tab}`}>
          {panels[tab]}
        </div>
      </aside>
      <button type="button" className="workspace-splitter" aria-label="Resize tools panel" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width} onKeyDown={keyResize} onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} />
      <section className="workspace-preview" aria-label="Preview">
        <div className="workspace-preview-heading"><EyeOpenIcon /><button type="button" role="tab" aria-selected="true" onClick={() => undefined}>Preview</button></div>
        {preview}
      </section>
    </section>
  );
}
