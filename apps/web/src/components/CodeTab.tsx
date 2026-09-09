import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/apiClient.js";
import type { SourceEditorResult } from "../hooks/useSourceEditor.js";

const MonacoEditor = lazy(() => import("@monaco-editor/react"));

export interface CodeTabProps {
  client: ApiClient;
  projectId: string | null;
  editor: SourceEditorResult;
  historicalSnapshotId: string | null;
  isHistorical: boolean;
}

export function CodeTab({ client, projectId, editor, historicalSnapshotId, isHistorical }: CodeTabProps) {
  const [historicalSource, setHistoricalSource] = useState<string | null>(null);
  const [historicalError, setHistoricalError] = useState<string | null>(null);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!projectId || !historicalSnapshotId || !isHistorical) {
      setHistoricalSource(null);
      return;
    }
    const request = ++requestId.current;
    setLoadingHistorical(true);
    setHistoricalError(null);
    client.getSnapshot(projectId, historicalSnapshotId).then((response) => {
      if (request === requestId.current) setHistoricalSource(response.scad.replace(/\r\n?/g, "\n"));
    }).catch((cause) => {
      if (request === requestId.current) setHistoricalError(cause instanceof Error ? cause.message : "Historical source unavailable.");
    }).finally(() => {
      if (request === requestId.current) setLoadingHistorical(false);
    });
  }, [client, projectId, historicalSnapshotId, isHistorical]);

  const readOnly = isHistorical || !projectId || editor.loading;
  const value = isHistorical ? historicalSource ?? "" : editor.draftScad;
  const status = isHistorical
    ? historicalError ? `Historical source unavailable: ${historicalError}` : loadingHistorical ? "Loading captured source…" : `Historical snapshot ${historicalSnapshotId} · read-only`
    : editor.loading ? "Loading source…" : editor.conflict ? "Conflict — draft is based on an older revision" : editor.dirty ? "Unsaved changes" : "Saved source";

  return (
    <div className="code-tab" data-testid="code-tab">
      <div className="code-toolbar">
        <div>
          <p className="eyebrow">OpenSCAD source</p>
          <p className={`code-status ${editor.conflict && !isHistorical ? "code-status--danger" : ""}`} role="status">{status}</p>
        </div>
        {!isHistorical ? (
          <div className="code-actions">
            <button type="button" className="button button--ghost" onClick={editor.discard} disabled={!editor.dirty || editor.saving}>Discard</button>
            <button type="button" className="button button--primary" onClick={editor.save} disabled={!editor.dirty || editor.saving || !projectId}>
              {editor.saving ? "Saving…" : "Save source"}
            </button>
          </div>
        ) : null}
      </div>

      {editor.saveError && !isHistorical ? <p className="inline-error" role="alert">{editor.saveError}</p> : null}
      {editor.pendingRemoved && !isHistorical ? (
        <div className="acknowledge-panel" role="alert" data-testid="removed-params-confirmation">
          <strong>Some overrides need your acknowledgement</strong>
          <p>This source change will remove or invalidate:</p>
          <ul>{editor.pendingRemoved.map((item) => <li key={item.name}><code>{item.name}</code> — {item.reason}</li>)}</ul>
          <div className="code-actions">
            <button type="button" className="button button--ghost" onClick={editor.cancelAcknowledge}>Keep editing</button>
            <button type="button" className="button button--danger" onClick={editor.acknowledgeSave}>Drop overrides and save</button>
          </div>
        </div>
      ) : null}

      <div className="editor-frame">
        <Suspense fallback={<textarea className="source-fallback" value={value} onChange={(event) => editor.setDraft(event.target.value)} readOnly={readOnly} aria-label="OpenSCAD source" spellCheck={false} />}>
          <MonacoEditor height="100%" language="cpp" theme="vs-light" value={value} onChange={(next) => { if (!readOnly && next !== undefined) editor.setDraft(next); }} options={{ readOnly, minimap: { enabled: false }, fontFamily: "IBM Plex Mono, monospace", fontSize: 13, lineNumbers: "on", padding: { top: 16, bottom: 16 }, automaticLayout: true, tabSize: 2, wordWrap: "on" }} />
        </Suspense>
      </div>
      {!isHistorical && editor.baseRevision ? <p className="code-footnote">Revision <code>{editor.baseRevision.slice(0, 12)}</code> · drafts recover per project in this tab</p> : null}
    </div>
  );
}
