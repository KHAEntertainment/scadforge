import { useMemo } from "react";
import type { ParamValues, ViewName } from "@scadforge/protocol";
import { createApiClient } from "./lib/apiClient.js";
import { useProject } from "./hooks/useProject.js";
import { useChat } from "./hooks/useChat.js";
import { useSnapshots } from "./hooks/useSnapshots.js";
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

  const pngUrls = useMemo<Partial<Record<ViewName, string | null>>>(() => {
    const renders = chat.state.headSnapshot?.renders ?? [];
    return Object.fromEntries(renders.map((render) => [render.view, render.url]));
  }, [chat.state.headSnapshot]);

  const validationBadge = chat.state.headSnapshot?.validation?.badge ?? null;

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
      <StatusStrip client={client} validationBadge={validationBadge} />
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
              stlUrl={chat.state.latestMeshUrl}
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
