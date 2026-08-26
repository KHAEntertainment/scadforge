import { useMemo } from "react";
import type { ViewName } from "@scadforge/protocol";
import { createApiClient } from "./lib/apiClient.js";
import { useProject } from "./hooks/useProject.js";
import { useChat } from "./hooks/useChat.js";
import { useSnapshots } from "./hooks/useSnapshots.js";
import { StatusStrip } from "./components/StatusStrip.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { Workspace } from "./components/Workspace.js";
import { PreviewTab } from "./components/PreviewTab.js";
import { HistoryTab } from "./components/HistoryTab.js";

export function App() {
  // Same-origin by default so a Vite dev-server proxy (or same-host prod
  // deploy) can forward `/api` to `apps/server` without this app hard-coding
  // a port.
  const client = useMemo(() => createApiClient(), []);

  const { project, loading: projectLoading, error: projectError } = useProject(client);
  const projectId = project?.id ?? null;

  const chat = useChat(client, projectId);
  const snapshots = useSnapshots(client, projectId);

  const pngUrls = useMemo<Partial<Record<ViewName, string | null>>>(() => {
    const renders = chat.state.headSnapshot?.renders ?? [];
    return Object.fromEntries(renders.map((render) => [render.view, render.url]));
  }, [chat.state.headSnapshot]);

  const validationBadge = chat.state.headSnapshot?.validation?.badge ?? null;

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
          preview={<PreviewTab stlUrl={chat.state.latestMeshUrl} pngUrls={pngUrls} />}
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
