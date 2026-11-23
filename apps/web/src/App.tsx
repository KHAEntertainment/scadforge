import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorReceipt, SnapshotManifest, ViewName } from "@scadforge/protocol";
import { createApiClient, type ApiClient } from "./lib/apiClient.js";
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
import { EditSurface } from "./components/editor/surface/EditSurface.js";
import { useEditorSession, type HostWriteReason } from "./components/editor/surface/useEditorSession.js";

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

/** F1: a failed post-commit source re-read; Build stays pressable and retries it. */
const SOURCE_RETRY_REASON = "The latest source could not be loaded. Press Build to try loading it again.";

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
  // Issue #79: `chat.state.headSnapshot` only resets to the new project's
  // state inside `useChat`'s own effect — one render behind a `projectId`
  // change, same as any other effect-driven reset. A plain ref comparison
  // (not `useState`, so this never itself triggers a render) is true for
  // exactly the first render after `projectId` changes, and lets that one
  // render ignore `chat.state.headSnapshot` entirely rather than briefly
  // treating the PREVIOUS project's head as this project's working head —
  // `snapshots.snapshots` is already correct at this point (see
  // `useSnapshots`'s own render-time reset), so `listedHead` alone is safe.
  const previousProjectIdForHeadRef = useRef(projectId);
  const switchingProjects = previousProjectIdForHeadRef.current !== projectId;
  previousProjectIdForHeadRef.current = projectId;
  const workingHead = useMemo<SnapshotManifest | null>(() => {
    const listedHead = snapshots.snapshots[0] ?? null;
    const chatHead = switchingProjects ? null : chat.state.headSnapshot;
    if (!chatHead) return listedHead;
    return snapshots.snapshots.some((snapshot) => snapshot.id === chatHead.id) ? listedHead : chatHead;
  }, [snapshots.snapshots, chat.state.headSnapshot, switchingProjects]);
  const workingHeadId = workingHead?.id ?? null;
  const liveSource = useLiveModelSource(client, projectId, workingHeadId);
  // F1: the source editor's reads and writes, tagged where they start. From an
  // accepted editor receipt until a read or write that STARTED after it has
  // returned a revision and the clean editor has adopted it, the source base is
  // stale and Build would send it (409). `sourceStale` holds that state for
  // one project; the tag (start sequence + project id) is what proves which
  // request a result belongs to.
  const sourceSeqRef = useRef(0);
  const [sourceStale, setSourceStale] = useState<{
    projectId: string;
    /** The source request sequence at the receipt: only later requests count. */
    sinceSeq: number;
    /** The revision of the latest-started post-receipt read/write that succeeded. */
    freshRevision: string | null;
    /** The latest-started post-receipt read failed; Build retries it. */
    failed: boolean;
    /** The sequence when the last re-read was requested (`null`: none yet). */
    requestedSeq: number | null;
    /** The latest-started post-receipt request that settled. */
    settledSeq: number;
  } | null>(null);
  const sourceClient = useMemo<ApiClient>(() => {
    const settle = (projectIdOfRequest: string, seq: number, revision: string | null) =>
      setSourceStale((prev) =>
        prev && prev.projectId === projectIdOfRequest && seq > prev.sinceSeq && seq >= prev.settledSeq
          ? { ...prev, settledSeq: seq, freshRevision: revision ?? prev.freshRevision, failed: revision === null }
          : prev
      );
    return {
      ...client,
      getSource(id: string) {
        const seq = ++sourceSeqRef.current;
        return client.getSource(id).then(
          (response) => {
            settle(id, seq, response.revision);
            return response;
          },
          (cause: unknown) => {
            settle(id, seq, null);
            throw cause;
          }
        );
      },
      // A save sent after the receipt can only have succeeded against the post-commit revision.
      updateSource(id: string, body: Parameters<ApiClient["updateSource"]>[1]) {
        const seq = ++sourceSeqRef.current;
        return client.updateSource(id, body).then((response) => {
          settle(id, seq, response.revision);
          return response;
        });
      }
    };
  }, [client]);
  // S3-C C4: params/source saves are external writes for the editor session (declared below).
  const reportEditorWriteRef = useRef<(reason: HostWriteReason) => void>(() => {});
  const handleSourceSaved = useCallback(() => {
    snapshots.refresh();
    reportEditorWriteRef.current("source-saved");
  }, [snapshots.refresh]);
  const sourceEditor = useSourceEditor(sourceClient, projectId, handleSourceSaved);
  const handleParamsSaved = useCallback(() => {
    snapshots.refresh();
    reportEditorWriteRef.current("params-saved");
  }, [snapshots.refresh]);
  const paramsController = useParamsController(client, projectId, workingHeadId, handleParamsSaved);
  const handleEditorCommitted = useCallback(
    (receipt: EditorReceipt) => {
      snapshots.refresh();
      setSourceStale({ projectId: receipt.projectId, sinceSeq: sourceSeqRef.current, freshRevision: null, failed: false, requestedSeq: null, settledSeq: 0 });
    },
    [snapshots.refresh]
  );
  const editorSession = useEditorSession({
    api: client,
    projectId,
    sourceDirty: sourceEditor.dirty,
    sourceConflict: sourceEditor.conflict,
    paramsDirty: paramsController.dirty.size > 0,
    paramsSaving: paramsController.saving,
    chatItems: chat.state.items,
    chatStreaming: chat.isStreaming,
    headSnapshotId: workingHeadId,
    onCommitted: handleEditorCommitted
  });
  reportEditorWriteRef.current = editorSession.reportWrite;

  // F1: drive the stale source base to fresh. A dirty or saving draft is never
  // reloaded over; the re-read waits until it is clean (Discard, or a save).
  const reloadSource = sourceEditor.reload;
  useEffect(() => {
    const stale = sourceStale;
    if (!stale) return;
    if (stale.projectId !== projectId) {
      setSourceStale(null); // a project switch: the new project's source loads fresh
      return;
    }
    if (sourceEditor.dirty || sourceEditor.saving) return;
    if (stale.freshRevision !== null && sourceEditor.baseRevision === stale.freshRevision) {
      setSourceStale(null);
      return;
    }
    if (stale.failed || sourceEditor.loading) return;
    if (stale.requestedSeq !== null && stale.settledSeq <= stale.requestedSeq) return; // our re-read has not settled yet
    setSourceStale({ ...stale, requestedSeq: sourceSeqRef.current });
    reloadSource();
  }, [sourceStale, projectId, sourceEditor.dirty, sourceEditor.saving, sourceEditor.loading, sourceEditor.baseRevision, reloadSource]);
  const sourceStaleHere = sourceStale !== null && sourceStale.projectId === projectId ? sourceStale : null;
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
  // F4: the mesh result is used for edit-preview decisions ONLY when its own
  // identity (the project and snapshot it was requested for) is the current
  // project's head; any other result counts as "no server mesh known".
  const headMesh = !historical && projectId !== null && workingHeadId !== null && mesh.projectId === projectId && mesh.snapshotId === workingHeadId ? mesh : null;
  const headMeshReady = headMesh !== null && headMesh.status === "ready" && headMesh.url !== null;
  // The viewer's own server URL obeys the same rule for the displayed snapshot.
  // A result without identity fields (a test stand-in) is used as before.
  const viewMesh =
    mesh.projectId === undefined || (mesh.projectId === projectId && mesh.snapshotId === currentSnapshotId) ? mesh : { url: null, status: "checking" as const };
  // This project's last server render (the last `ready` head mesh), the edit
  // preview's fallback while it has nothing to show.
  const [lastServerRender, setLastServerRender] = useState<{ projectId: string; snapshotId: string; url: string } | null>(null);
  useEffect(() => {
    if (mesh.status === "ready" && mesh.url && mesh.projectId && mesh.snapshotId && mesh.projectId === projectId && mesh.snapshotId === workingHeadId) {
      setLastServerRender({ projectId: mesh.projectId, snapshotId: mesh.snapshotId, url: mesh.url });
    }
  }, [mesh, projectId, workingHeadId]);
  const fallback = lastServerRender?.projectId === projectId ? lastServerRender : null;
  // G1: the local preview takes the viewer only while it is the subject (a
  // gesture, a save, a post-receipt step, or a saved edit the head has not
  // caught up with, L4) or the head has no known server mesh; otherwise the
  // validated server mesh stays, with Inspect and Measure.
  const editBinding = !historical && editorSession.editPreview?.projectId === projectId ? editorSession.editPreview : null;
  const editPreview =
    editBinding && (editBinding.inUse || !headMeshReady)
      ? {
          objectUrl: editBinding.objectUrl,
          status: editBinding.status,
          fallbackUrl: fallback?.url ?? null,
          fallbackIsHead: fallback !== null && fallback.snapshotId === workingHeadId && !editBinding.headStale,
          checking: !(headMesh !== null && headMesh.status === "absent"),
          // L4: why the pre-commit mesh is not shown yet, with a way out if the list refresh failed or hangs.
          notice: editBinding.headStale
            ? {
                text: snapshots.error
                  ? "The snapshot list could not be refreshed, so the server render of your saved edit is not known yet."
                  : "Waiting for the snapshot list to show your saved edit.",
                actionLabel: "Retry",
                onAction: snapshots.refresh
              }
            : null
        }
      : null;
  // F1: from an edit's commit until the source editor has the post-commit
  // revision, Build would send a stale base revision (409).
  const editorSaving = editorSession.state.kind === "committing" || editorSession.state.kind === "resolving";
  // Issue #78: every inline Build CTA (Preview's empty state, the status
  // panel's "Not validated" state) mirrors the header Build button's own
  // disabled conditions, plus one case the header doesn't have — Build
  // always targets the head, so an inline CTA shown while viewing a
  // DIFFERENT (historical) snapshot would silently fix the wrong thing.
  const buildDisabledReason = !projectId
    ? "Select a project first."
    : buildState === "building"
      ? "Building…"
      : chat.isStreaming
        ? "Finish the active chat turn before building."
        : sourceEditor.saving
          ? "Saving your source edits…"
          : sourceEditor.dirty
            ? "Save or discard your source edits before building."
            : editorSaving
              ? "Wait for your edit to finish saving before building."
              : sourceStaleHere
                ? sourceStaleHere.failed
                  ? SOURCE_RETRY_REASON
                  : "Loading the latest source before building…"
                : historical
                  ? "Build validates the current head; select the head to build"
                  : null;
  // A failed source re-read keeps Build pressable: pressing it retries the re-read.
  const buildDisabled = buildDisabledReason !== null && buildDisabledReason !== SOURCE_RETRY_REASON;
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
    // The header's Build button has its own disabled rule; this covers it too.
    if (sourceStaleHere?.failed && !editorSaving) {
      setSourceStale({ ...sourceStaleHere, failed: false, requestedSeq: sourceSeqRef.current });
      sourceEditor.reload();
      setHeaderNotice("The latest source could not be loaded; trying again. Press Build once it has loaded.");
      return;
    }
    if (sourceStaleHere && !editorSaving && sourceStaleHere.requestedSeq !== null && sourceStaleHere.settledSeq <= sourceStaleHere.requestedSeq) {
      // The re-read is still out (it may hang: there is no timeout): pressing Build starts a new one.
      setSourceStale({ ...sourceStaleHere, requestedSeq: sourceSeqRef.current });
      sourceEditor.reload();
      setHeaderNotice("Still loading the latest source; trying again. Press Build once it has loaded.");
      return;
    }
    if (editorSaving || sourceStaleHere) {
      setHeaderNotice(buildDisabledReason);
      return;
    }
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
          preview={<PreviewTab key={`preview-${projectId ?? "no-project"}`} stlUrl={viewMesh.url} meshStatus={viewMesh.status} snapshotId={currentSnapshotId} validation={validation} pngUrls={pngUrls} liveScad={effectiveScad} liveParams={liveParams} historical={historical} onReturnToCurrent={() => setSelectedSnapshotId(null)} onBuild={() => void build()} building={buildState === "building"} buildDisabled={buildDisabled} buildDisabledReason={buildDisabledReason} editPreview={editPreview} />}
          chat={<ChatPanel state={chat.state} isStreaming={chat.isStreaming} streamError={chat.streamError} onSend={(text) => void chat.sendMessage(text)} disabled={projectLoading || !projectId || sourceEditor.dirty} onCheckConnection={() => void chat.checkConnectionResult()} onDismissConnection={chat.dismissConnectionLost} />}
          edit={<EditSurface session={editorSession} />}
          onTabChange={(tab) => {
            if (tab !== "edit") editorSession.adapter.notifyToolChange();
          }}
          params={<ParamsTab controller={paramsController} onAskAgent={(text) => void chat.sendMessage(text)} disabled={projectLoading || !projectId || sourceEditor.dirty} />}
          code={<CodeTab client={client} projectId={projectId} editor={sourceEditor} historicalSnapshotId={selectedSnapshotId} isHistorical={historical} />}
          history={<HistoryTab key={`history-${projectId ?? "no-project"}`} client={client} projectId={projectId} snapshots={snapshots.snapshots} loading={snapshots.loading} error={snapshots.error} onExported={snapshots.refresh} onReverted={() => editorSession.reportWrite("reverted")} onSelectSnapshot={(id) => setSelectedSnapshotId(id)} />}
        />
      </main>
      {projectError ? <p className="app-error" role="alert">{projectError}</p> : null}
      {pendingProjectId ? <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="switch-project-title"><div className="modal-heading"><div><p className="eyebrow">Unsaved source</p><h2 id="switch-project-title">Save before switching?</h2></div></div><p>Your Code tab has edits based on revision <code>{sourceEditor.baseRevision?.slice(0, 12)}</code>. Keep them before opening another project.</p><div className="modal-actions"><button type="button" className="button button--ghost" onClick={() => setPendingProjectId(null)}>Cancel</button><button type="button" className="button button--danger" onClick={() => { const next = pendingProjectId; sourceEditor.discard(); projectState.selectProject(next); setPendingProjectId(null); }}>Discard edits</button><button type="button" className="button button--primary" onClick={() => { sourceEditor.save(); }}>Save & switch</button></div></div></div> : null}
    </div>
  );
}
