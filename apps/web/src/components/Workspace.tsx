import { useState, type ReactNode } from "react";

export type WorkspaceTab = "preview" | "history";

export interface WorkspaceProps {
  preview: ReactNode;
  history: ReactNode;
}

/** SDP §9: right workspace with Preview (default) + History tabs. */
export function Workspace({ preview, history }: WorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>("preview");

  return (
    <section className="workspace" aria-label="Workspace">
      <div className="workspace-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "preview"}
          className={tab === "preview" ? "active" : ""}
          onClick={() => setTab("preview")}
        >
          Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          className={tab === "history" ? "active" : ""}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>
      <div className="workspace-content">{tab === "preview" ? preview : history}</div>
    </section>
  );
}
