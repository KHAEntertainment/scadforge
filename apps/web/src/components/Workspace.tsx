import { useState, type ReactNode } from "react";

export type WorkspaceTab = "preview" | "params" | "history";

export interface WorkspaceProps {
  preview: ReactNode;
  /** Issue #33: schema-driven Params tab. */
  params: ReactNode;
  history: ReactNode;
}

/** SDP §9: right workspace with Preview (default), Params, and History tabs. */
export function Workspace({ preview, params, history }: WorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>("preview");

  const content = tab === "preview" ? preview : tab === "params" ? params : history;

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
          aria-selected={tab === "params"}
          className={tab === "params" ? "active" : ""}
          onClick={() => setTab("params")}
        >
          Params
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
      <div className="workspace-content">{content}</div>
    </section>
  );
}
