import { useState, type FormEvent } from "react";
import type { ProjectManifest } from "@scadforge/protocol";
import { ChevronDownIcon, DownloadIcon, GearIcon, PlusIcon, RocketIcon, CheckCircledIcon, Cross1Icon } from "@radix-ui/react-icons";

export interface StudioHeaderProps {
  projects: ProjectManifest[];
  selectedId: string | null;
  projectName: string | null;
  loading?: boolean;
  creating?: boolean;
  createError?: string | null;
  activeTurn?: boolean;
  dirty?: boolean;
  saving?: boolean;
  building?: boolean;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string, scad?: string) => Promise<ProjectManifest | null>;
  onBuild: () => void;
  onExport: (format: "3mf" | "stl") => void;
  onExportSource: () => void;
}

export function StudioHeader({ projects, selectedId, projectName, loading, creating, createError, activeTurn, dirty, saving, building, onSelectProject, onCreateProject, onBuild, onExport, onExportSource }: StudioHeaderProps) {
  const [showNew, setShowNew] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [name, setName] = useState("");
  const [scad, setScad] = useState("cube(20);\n");
  const [switchMessage, setSwitchMessage] = useState<string | null>(null);

  function selectProject(id: string) {
    if (id === selectedId) return;
    if (activeTurn) {
      setSwitchMessage("Finish the active chat turn before switching projects.");
      return;
    }
    onSelectProject(id);
  }

  async function submitNew(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = await onCreateProject(trimmed, scad.trim() ? scad : undefined);
    if (created) {
      setName("");
      setScad("cube(20);\n");
      setShowNew(false);
    }
  }

  return (
    <>
      <header className="studio-header">
        <div className="brand-lockup"><span className="brand-mark">SF</span><span>Scad Forge</span></div>
        <div className="project-control">
          <label htmlFor="project-select">Project</label>
          <select id="project-select" value={selectedId ?? ""} onChange={(event) => selectProject(event.target.value)} disabled={loading || projects.length === 0}>
            {projects.length === 0 ? <option value="">No projects yet</option> : projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button type="button" className="icon-button" aria-label="New project" onClick={() => setShowNew(true)}><PlusIcon /></button>
        </div>
        <div className="header-context"><span className="branch-pill">main</span><span className="ready-pill"><CheckCircledIcon /> {activeTurn ? "Working" : dirty ? "Draft" : "Ready"}</span><span className="header-project-name">{projectName ?? "Choose a project to begin"}</span></div>
        <div className="header-actions">
          <button type="button" className="button button--secondary" onClick={onBuild} disabled={!selectedId || dirty || saving || activeTurn || building}><RocketIcon /> {building ? "Building…" : "Build"}</button>
          <div className="export-menu">
            <button type="button" className="button button--primary" onClick={() => setShowExport((value) => !value)} disabled={!selectedId || dirty || saving}><DownloadIcon /> Export <ChevronDownIcon /></button>
            {showExport ? <div className="export-popover" role="menu">
              <button type="button" role="menuitem" onClick={() => { setShowExport(false); onExport("3mf"); }}>Export 3MF</button>
              <button type="button" role="menuitem" onClick={() => { setShowExport(false); onExport("stl"); }}>Export STL</button>
              <button type="button" role="menuitem" onClick={() => { setShowExport(false); onExportSource(); }}>Download source</button>
            </div> : null}
          </div>
          <button type="button" className="icon-button" aria-label="Settings"><GearIcon /></button>
        </div>
      </header>
      {switchMessage ? <div className="header-notice" role="alert">{switchMessage}<button type="button" aria-label="Dismiss" onClick={() => setSwitchMessage(null)}><Cross1Icon /></button></div> : null}
      {showNew ? <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
        <div className="modal-heading"><div><p className="eyebrow">Workspace</p><h2 id="new-project-title">New project</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={() => setShowNew(false)}><Cross1Icon /></button></div>
        <form onSubmit={submitNew}>
          <label className="field-label" htmlFor="new-project-name">Project name</label>
          <input id="new-project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. hinge bracket" autoFocus />
          <label className="field-label" htmlFor="new-project-source">Starting source <span>(optional)</span></label>
          <textarea id="new-project-source" value={scad} onChange={(event) => setScad(event.target.value)} rows={5} spellCheck={false} />
          {createError ? <p className="inline-error" role="alert">{createError}</p> : null}
          <div className="modal-actions"><button type="button" className="button button--ghost" onClick={() => setShowNew(false)}>Cancel</button><button type="submit" className="button button--primary" disabled={!name.trim() || creating}>{creating ? "Creating…" : "Create project"}</button></div>
        </form>
      </div></div> : null}
    </>
  );
}
