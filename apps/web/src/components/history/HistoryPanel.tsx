import { useEffect, useState } from "react";
import type { SnapshotManifest } from "@scadforge/protocol";
import type { ApiClient } from "../../lib/apiClient.js";
import { SnapshotList } from "./SnapshotList.js";
import { DiffView } from "./DiffView.js";
import { RevertButton } from "./RevertButton.js";
import { useSnapshotDiff } from "./useSnapshotDiff.js";

export interface HistoryPanelProps {
  client: ApiClient;
  projectId: string | null;
  snapshots: SnapshotManifest[];
  loading: boolean;
  error: string | null;
  /** Refetches the snapshot list — called after a successful revert so the UI reflects the new head (Issue #34 AC). */
  onChanged: () => void;
}

/**
 * SDP §9 History tab: snapshot list + diff + revert, wired together (Issue
 * #34). `snapshots` is newest-first per the frozen `ListSnapshotsResponse` —
 * this component selects the first (newest) entry by default and keeps the
 * selection pinned to whatever snapshot is currently selected as the list
 * refreshes, falling back to the new newest entry if the selection
 * disappears (it never does today — history is append-only — but the list
 * can still refresh out from under an in-flight selection).
 */
export function HistoryPanel({ client, projectId, snapshots, loading, error, onChanged }: HistoryPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId((prev) => {
      if (snapshots.length === 0) return null;
      if (prev && snapshots.some((s) => s.id === prev)) return prev;
      return snapshots[0].id;
    });
  }, [snapshots]);

  const diffState = useSnapshotDiff(client, projectId, selectedId);
  const headId = snapshots[0]?.id ?? null;

  function handleReverted(newSnapshot: SnapshotManifest) {
    onChanged();
    setSelectedId(newSnapshot.id);
  }

  return (
    <div className="history-panel" data-testid="history-panel">
      <div className="history-panel-list">
        <SnapshotList
          client={client}
          snapshots={snapshots}
          loading={loading}
          error={error}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
      <div className="history-panel-detail">
        <DiffView
          loading={diffState.loading}
          error={diffState.error}
          diff={diffState.diff}
          parentId={diffState.parentId}
          snapshotId={selectedId}
        />
        <RevertButton
          client={client}
          projectId={projectId}
          snapshotId={selectedId}
          isHead={selectedId !== null && selectedId === headId}
          onReverted={handleReverted}
        />
      </div>
    </div>
  );
}
