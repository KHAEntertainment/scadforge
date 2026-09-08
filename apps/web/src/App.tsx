import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SnapshotManifest, ViewName } from "@scadforge/protocol";
import { createApiClient } from "./lib/apiClient.js";
import { useProject } from "./hooks/useProject.js";
import { useChat } from "./hooks/useChat.js";
import { useSnapshots } from "./hooks/useSnapshots.js";
import { useSnapshotMesh } from "./hooks/useSnapshotMesh.js";
import { useLiveModelSource } from "./hooks/useLiveModelSource.js";
import { StatusStrip } from "./components/StatusStrip.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { Workspace } from "./components/Workspace.js";
import { PreviewTab } from "./components/PreviewTab.js";
import { HistoryTab } from "./components/HistoryTab.js";
import { ParamsTab } from "./components/params/ParamsTab.js";
import { useParamsController } from "./components/params/useParamsController.js";

export function App() {
  // Same-origin by default so a Vite dev-server proxy (or same-host prod
  // deploy) can forward `/api` to `apps/server` without this app hard-coding
  // a port.
  const client = useMemo(() => createApiClient(), []);

  const { project, loading: projectLoading, error: projectError } = useProject(client);
  const projectId = project?.id ?? null;

  const chat = useChat(client, projectId);
  const snapshots = useSnapshots(client, projectId);

  /**
   * The freshest known project head. A `snapshot_created` event can arrive
   * before the next list request completes, so an unlisted chat snapshot is a
   * short-lived fast path. Once that id appears in the list, the list wins:
   * it is newest-first and carries late render/validation enrichment that the
   * creation-time SSE record cannot contain.
   */
  const workingHead = useMemo<SnapshotManifest | null>(() => {
    const listedHead = snapshots.snapshots[0] ?? null;
    const chatHead = chat.state.headSnapshot;
    if (!chatHead) return listedHead;
    const chatHeadIsListed = snapshots.snapshots.some((snapshot) => snapshot.id === chatHead.id);
    return chatHeadIsListed ? listedHead : chatHead;
  }, [snapshots.snapshots, chat.state.headSnapshot]);
  const workingHeadId = workingHead?.id ?? null;

  const liveSource = useLiveModelSource(client, projectId, workingHeadId);
  const handleParamsSaved = useCallback(() => snapshots.refresh(), [snapshots.refresh]);
  const paramsController = useParamsController(client, projectId, workingHeadId, handleParamsSaved);

  // Refresh immediately when a turn announces a snapshot, then once more
  // when the stream closes: render/validation artifacts attach after snapshot
  // creation and may not be present in the first list response.
  const chatHeadId = chat.state.headSnapshot?.id ?? null;
  useEffect(() => {
    if (chatHeadId) snapshots.refresh();
  }, [chatHeadId, snapshots.refresh]);

  const turnWasStreamingRef = useRef(false);
  useEffect(() => {
    if (chat.isStreaming) {
      turnWasStreamingRef.current = true;
      return;
    }
    if (turnWasStreamingRef.current) {
      turnWasStreamingRef.current = false;
      snapshots.refresh();
    }
  }, [chat.isStreaming, snapshots.refresh]);

  // Which snapshot the History tab has selected, if the user has picked one.
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);

  // Preserve a deliberate historical selection across same-head list
  // refreshes/enrichment, but pull the preview forward whenever the actual
  // working head id advances (chat, params save, manual save, or revert).
  const previousWorkingHeadIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousWorkingHeadIdRef.current;
    previousWorkingHeadIdRef.current = workingHeadId;
    if (previous !== null && previous !== workingHeadId) setSelectedSnapshotId(null);
  }, [workingHeadId]);

  /**
   * The snapshot every panel below renders (Issue #41 cause (c)).
   *
   * The old code read the viewer's mesh URL straight off live chat state, so
   * the preview only ever worked during the few seconds of a turn: History
   * selection showed nothing, and a refresh blanked it even though the renders
   * were sitting on disk. Resolving a snapshot here — preferring an explicit
   * selection, then the turn that just finished, then the newest persisted
   * one — means the preview is driven by durable state and a refresh restores
   * it. `snapshots` is newest-first per the frozen `ListSnapshotsResponse`.
   */
  const currentSnapshot = useMemo<SnapshotManifest | null>(() => {
    const selected = selectedSnapshotId
      ? (snapshots.snapshots.find((s) => s.id === selectedSnapshotId) ?? null)
      : null;
    if (selected) return selected;
    return workingHead;
  }, [selectedSnapshotId, snapshots.snapshots, workingHead]);

  const currentSnapshotId = currentSnapshot?.id ?? null;
  const mesh = useSnapshotMesh(client, projectId, currentSnapshotId);

  const pngUrls = useMemo<Partial<Record<ViewName, string | null>>>(() => {
    const renders = currentSnapshot?.renders ?? [];
    // `resolveUrl` so a configured non-same-origin baseUrl is honoured; the
    // manifest stores server-relative paths.
    return Object.fromEntries(renders.map((render) => [render.view, client.resolveUrl(render.url)]));
  }, [currentSnapshot, client]);

  const validation = currentSnapshot?.validation ?? null;

  const handleSelectSnapshot = useCallback((id: string) => setSelectedSnapshotId(id), []);

  // The controller's bag is a COMPLETE override bag, not a partial diff.
  // `{}` is therefore authoritative after a revert to defaults and must not
  // be merged with stale values from a previous `getProject` response.
  const liveParams = paramsController.debouncedValues;

  return (
    <div className="app">
      <StatusStrip client={client} validationBadge={validation?.badge ?? null} />
      <div className="app-body">
        <ChatPanel
          state={chat.state}
          isStreaming={chat.isStreaming}
          streamError={chat.streamError}
          onSend={(text) => void chat.sendMessage(text)}
          disabled={projectLoading || !projectId}
        />
        <Workspace
          preview={
            <PreviewTab
              stlUrl={mesh.url}
              meshStatus={mesh.status}
              snapshotId={currentSnapshotId}
              validation={validation}
              pngUrls={pngUrls}
              liveScad={liveSource.scad}
              liveParams={liveParams}
            />
          }
          params={
            <ParamsTab
              controller={paramsController}
              onAskAgent={(text) => void chat.sendMessage(text)}
              disabled={projectLoading || !projectId}
            />
          }
          history={
            <HistoryTab
              client={client}
              projectId={projectId}
              snapshots={snapshots.snapshots}
              loading={snapshots.loading}
              error={snapshots.error}
              onExported={snapshots.refresh}
              onSelectSnapshot={handleSelectSnapshot}
            />
          }
        />
      </div>
      {projectError ? (
        <p className="app-error" role="alert">
          {projectError}
        </p>
      ) : null}
    </div>
  );
}
