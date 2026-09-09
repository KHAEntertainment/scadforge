import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotManifest, ViewName } from "@scadforge/protocol";
import { createApiClient } from "./lib/apiClient.js";
import { useProject } from "./hooks/useProject.js";
import { useChat } from "./hooks/useChat.js";
import { useSnapshots } from "./hooks/useSnapshots.js";
import { useSnapshotMesh } from "./hooks/useSnapshotMesh.js";
import { useLiveModelSource } from "./hooks/useLiveModelSource.js";
import { useSourceEditor } from "./hooks/useSourceEditor.js";
import { StatusStrip } from "./components/StatusStrip.js";
import { StudioHeader } from "./components/StudioHeader.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { Workspace } from "./components/Workspace.js";
import { PreviewTab } from "./components/PreviewTab.js";
import { HistoryTab } from "./components/HistoryTab.js";
import { CodeTab } from "./components/CodeTab.js";
import { ParamsTab } from "./components/params/ParamsTab.js";
import { useParamsController } from "./components/params/useParamsController.js";

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function App() {
  const client = useMemo(() => createApiClient(), []);
  const projectState = useProject(client);
  const { project, projects, selectedId, projectLoading, error: projectError } = {
    project: projectState.project,
    projects: projectState.projects ?? [],
    selectedId: projectState.selectedId ?? projectState.project?.id ?? null,
    projectLoading: projectState.loading,
    error: projectState.error
  };
  const projectId = selectedId;
  const chat = useChat(client, projectId);
  const snapshots = useSnapshots(client, projectId);
  const workingHead = useMemo<SnapshotManifest | null>(() => {
    const listedHead = snapshots.snapshots[0] ?? null;
    const chatHead = chat.state.headSnapshot;
    if (!chatHead) return listedHead;
    return snapshots.snapshots.some((snapshot) => snapshot.id === chatHead.id) ? listedHead : chatHead;
  }, [snapshots.snapshots, chat.state.headSnapshot]);
  const workingHeadId = workingHead?.id ?? null;
  const liveSource = useLiveModelSource(client, projectId, workingHeadId);
  const sourceEditor = useSourceEditor(client, projectId, snapshots.refresh);
  const handleParamsSaved = useCallback(() => snapshots.refresh(), [snapshots.refresh]);
  const paramsController = useParamsController(client, projectId, workingHeadId, handleParamsSaved);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [headerNotice, setHeaderNotice] = useState<string | null>(null);
  const [buildState, setBuildState] = useState<"idle" | "building">("idle");
  const [exportState, setExportState] = useState<string | null>(null);
  const [historicalSource, setHistoricalSource] = useState<{ snapshotId: string; scad: string; params: SnapshotManifest["params"] } | null>(null);
  const historicalRequestRef = useRef(0);

  useEffect(() => {
    if (pendingProjectId && !sourceEditor.dirty && !sourceEditor.saving) {
      projectState.selectProject(pendingProjectId);
      setPendingProjectId(null);
    }
  }, [pendingProjectId, sourceEditor.dirty, sourceEditor.saving, projectState.selectProject]);

  // Historical Live mode must use the selected snapshot's captured source and
  // overrides. Load it independently from the current-head source and ignore
  // late replies when the user changes selection or project.
  useEffect(() => {
    const request = ++historicalRequestRef.current;
    if (!projectId || !selectedSnapshotId || selectedSnapshotId === workingHeadId) {
      setHistoricalSource(null);
      return;
    }
    setHistoricalSource(null);
    client.getSnapshot(projectId, selectedSnapshotId).then((response) => {
      if (request !== historicalRequestRef.current) return;
      setHistoricalSource({
        snapshotId: selectedSnapshotId,
        scad: response.scad,
        params: response.snapshot.params
      });
    }).catch(() => {
      if (request === historicalRequestRef.current) setHistoricalSource(null);
    });
  }, [client, projectId, selectedSnapshotId, workingHeadId]);

  const previousWorkingHeadIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousWorkingHeadIdRef.current;
    previousWorkingHeadIdRef.current = workingHeadId;
    if (previous !== null && previous !== workingHeadId) setSelectedSnapshotId(null);
  }, [workingHeadId]);

  const currentSnapshot = useMemo<SnapshotManifest | null>(() => {
    const selected = selectedSnapshotId ? snapshots.snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null : null;
    return selected ?? workingHead;
  }, [selectedSnapshotId, snapshots.snapshots, workingHead]);
  const currentSnapshotId = currentSnapshot?.id ?? null;
  const mesh = useSnapshotMesh(client, projectId, currentSnapshotId);
  const pngUrls = useMemo<Partial<Record<ViewName, string | null>>>(() => Object.fromEntries((currentSnapshot?.renders ?? []).map((render) => [render.view, client.resolveUrl(render.url)])), [currentSnapshot, client]);
  const validation = currentSnapshot?.validation ?? null;
  const historical = selectedSnapshotId !== null && selectedSnapshotId !== workingHeadId;
  const liveSourceReady = (liveSource.projectId === undefined || liveSource.projectId === projectId)
    && (liveSource.headSnapshotId === undefined || liveSource.headSnapshotId === workingHeadId)
    && liveSource.scad !== null;
  const effectiveScad = historical
    ? (historicalSource?.snapshotId === selectedSnapshotId ? historicalSource.scad : null)
    : (sourceEditor.draftScad || (liveSourceReady ? liveSource.scad : null));
  const liveParams = historical
    ? (historicalSource?.snapshotId === selectedSnapshotId ? historicalSource.params : {})
    : (paramsController.initialized ? paramsController.debouncedValues : (liveSourceReady ? liveSource.params : {}));

  useEffect(() => {
    const chatHeadId = chat.state.headSnapshot?.id;
    if (chatHeadId) snapshots.refresh();
  }, [chat.state.headSnapshot?.id, snapshots.refresh]);
  const turnWasStreamingRef = useRef(false);
  useEffect(() => {
    if (chat.isStreaming) turnWasStreamingRef.current = true;
    else if (turnWasStreamingRef.current) { turnWasStreamingRef.current = false; snapshots.refresh(); }
  }, [chat.isStreaming, snapshots.refresh]);

  function requestProjectSwitch(id: string) {
    if (id === projectId) return;
    if (chat.isStreaming) {
      setHeaderNotice("Finish the active chat turn before switching projects.");
      return;
    }
    if (sourceEditor.dirty) setPendingProjectId(id);
    else projectState.selectProject(id);
  }

  const handleCreateProject = useCallback(async (name: string, scad?: string) => {
    if (chat.isStreaming) {
      setHeaderNotice("Finish the active chat turn before creating or switching projects.");
      return null;
    }
    if (sourceEditor.dirty || sourceEditor.saving) {
      setHeaderNotice("Save, discard, or cancel your current draft before creating or switching projects.");
      return null;
    }
    const originProjectId = projectId;
    const created = await projectState.createProject(name, scad, { select: false });
    if (!created) return null;
    // Creation is asynchronous; re-check the guard before changing the active
    // project so a turn/edit that began while the request was in flight wins.
    if (chat.isStreaming) {
      setHeaderNotice("Project created. Finish the active chat turn before switching to it.");
    } else if (sourceEditor.dirty || sourceEditor.saving) {
      setPendingProjectId(created.id);
    } else if (originProjectId === projectId) {
      projectState.selectProject(created.id);
    } else {
      setHeaderNotice("Project created, but the active project changed while it was being created.");
    }
    return created;
  }, [chat.isStreaming, projectId, projectState, sourceEditor.dirty, sourceEditor.saving]);

  async function build() {
    if (!projectId || sourceEditor.dirty || !sourceEditor.baseRevision) return;
    setBuildState("building");
    setHeaderNotice(null);
    try {
      const result = await client.build(projectId, { base_revision: sourceEditor.baseRevision });
      snapshots.refresh();
      setSelectedSnapshotId(result.snapshot.id);
      setHeaderNotice(`Build complete — snapshot ${result.snapshot.id} is pinned to the preview.`);
    } catch (cause) {
      setHeaderNotice(cause instanceof Error ? cause.message : "Build failed.");
    } finally { setBuildState("idle"); }
  }

  async function exportModel(format: "3mf" | "stl") {
    if (!projectId) return;
    setExportState(`Exporting ${format.toUpperCase()}…`);
    try {
      const result = await client.exportModel(projectId, { format, allow_validation_failure: false });
      const blob = await client.fetchExportFile(result.export.url);
      triggerDownload(blob, result.export.file);
      setExportState(`${format.toUpperCase()} downloaded.`);
    } catch (cause) {
      setExportState(cause instanceof Error ? cause.message : "Export failed.");
    }
  }

  function exportSource() {
    if (!sourceEditor.savedScad) return;
    triggerDownload(new Blob([sourceEditor.savedScad], { type: "text/plain" }), `${project?.name ?? "scadforge-model"}.scad`);
    setExportState("Source downloaded.");
  }

  return (
    <div className="app">
      <StudioHeader projects={projects} selectedId={projectId} projectName={project?.name ?? null} loading={projectLoading} creating={projectState.creating} createError={projectState.createError} activeTurn={chat.isStreaming} dirty={sourceEditor.dirty} saving={sourceEditor.saving} building={buildState === "building"} onSelectProject={requestProjectSwitch} onCreateProject={handleCreateProject} onBuild={() => void build()} onExport={(format) => void exportModel(format)} onExportSource={exportSource} />
      <StatusStrip client={client} validationBadge={validation?.badge ?? null} />
      {headerNotice || exportState ? <div className="studio-notice" role="status">{headerNotice ?? exportState}<button type="button" aria-label="Dismiss notice" onClick={() => { setHeaderNotice(null); setExportState(null); }}>Dismiss</button></div> : null}
      <main className="app-body">
        <Workspace
          preview={<PreviewTab stlUrl={mesh.url} meshStatus={mesh.status} snapshotId={currentSnapshotId} validation={validation} pngUrls={pngUrls} liveScad={effectiveScad} liveParams={liveParams} historical={historical} onReturnToCurrent={() => setSelectedSnapshotId(null)} />}
          chat={<ChatPanel state={chat.state} isStreaming={chat.isStreaming} streamError={chat.streamError} onSend={(text) => void chat.sendMessage(text)} disabled={projectLoading || !projectId || sourceEditor.dirty} />}
          params={<ParamsTab controller={paramsController} onAskAgent={(text) => void chat.sendMessage(text)} disabled={projectLoading || !projectId || sourceEditor.dirty} />}
          code={<CodeTab client={client} projectId={projectId} editor={sourceEditor} historicalSnapshotId={selectedSnapshotId} isHistorical={historical} />}
          history={<HistoryTab client={client} projectId={projectId} snapshots={snapshots.snapshots} loading={snapshots.loading} error={snapshots.error} onExported={snapshots.refresh} onSelectSnapshot={(id) => setSelectedSnapshotId(id)} />}
        />
      </main>
      {projectError ? <p className="app-error" role="alert">{projectError}</p> : null}
      {pendingProjectId ? <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="switch-project-title"><div className="modal-heading"><div><p className="eyebrow">Unsaved source</p><h2 id="switch-project-title">Save before switching?</h2></div></div><p>Your Code tab has edits based on revision <code>{sourceEditor.baseRevision?.slice(0, 12)}</code>. Keep them before opening another project.</p><div className="modal-actions"><button type="button" className="button button--ghost" onClick={() => setPendingProjectId(null)}>Cancel</button><button type="button" className="button button--danger" onClick={() => { const next = pendingProjectId; sourceEditor.discard(); projectState.selectProject(next); setPendingProjectId(null); }}>Discard edits</button><button type="button" className="button button--primary" onClick={() => { sourceEditor.save(); }}>Save & switch</button></div></div></div> : null}
    </div>
  );
}
