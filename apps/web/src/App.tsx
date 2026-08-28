import { useCallback, useEffect, useMemo, useState } from "react";
import type { ParamValues, SnapshotManifest, ViewName } from "@scadforge/protocol";
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
  const headSnapshotId = chat.state.headSnapshot?.id ?? null;
  const liveSource = useLiveModelSource(client, projectId, headSnapshotId);
  const paramsController = useParamsController(client, projectId, headSnapshotId);

  // Which snapshot the History tab has selected, if the user has picked one.
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);

  // A turn that produces a new snapshot pulls the preview forward to it.
  // Without this, having ever clicked a row in History would pin the viewer to
  // that older snapshot and the next turn's result would silently not show.
  useEffect(() => {
    if (headSnapshotId) setSelectedSnapshotId(null);
  }, [headSnapshotId]);

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
    // The live head can be newer than the last `GET /snapshots`, so it is
    // preferred over the list; the list is what survives a refresh.
    return chat.state.headSnapshot ?? snapshots.snapshots[0] ?? null;
  }, [selectedSnapshotId, snapshots.snapshots, chat.state.headSnapshot]);

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

  // The debounced Params-tab working values are the live-preview source of
  // truth once loaded (they always carry the FULL merged bag, from either a
  // GET or a PUT echo); `liveSource.params` (the last server-fetched project
  // params) is only the fallback before that first load resolves.
  const liveParams = useMemo<ParamValues>(
    () => ({ ...liveSource.params, ...paramsController.debouncedValues }),
    [liveSource.params, paramsController.debouncedValues]
  );

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
