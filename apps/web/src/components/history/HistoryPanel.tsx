import { useEffect, useRef, useState } from "react";
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
  /**
   * Notifies the owner which snapshot is selected, so the Preview tab can show
   * that snapshot's mesh and renders (Issue #41).
   *
   * Selection state stays HERE rather than being lifted: this component
   * already handles the awkward cases (a list that refreshes under an
   * in-flight selection, a revert that should select the new snapshot), and
   * moving that up would duplicate it. The owner only needs to be told.
   */
  onSelected?: (id: string) => void;
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
export function HistoryPanel({
  client,
  projectId,
  snapshots,
  loading,
  error,
  onChanged,
  onSelected
}: HistoryPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const headId = snapshots[0]?.id ?? null;
  const previousHeadIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previousHeadId = previousHeadIdRef.current;
    previousHeadIdRef.current = headId;
    setSelectedId((prev) => {
      if (snapshots.length === 0) return null;
      // A new head is a new working result, so move the History detail to it.
      // Same-id list refreshes only enrich existing records and must preserve
      // a deliberate historical selection.
      if (previousHeadId !== null && headId !== previousHeadId) return headId;
      if (prev && snapshots.some((s) => s.id === prev)) return prev;
      return snapshots[0].id;
    });
  }, [headId, snapshots]);

  const diffState = useSnapshotDiff(client, projectId, selectedId);

  /**
   * Only a DELIBERATE pick is reported upward — not the default selection the
   * effect above makes, and not the re-pin after a list refresh. Reporting
   * those would let merely opening the History tab override the preview's own
   * choice of snapshot, which is the behaviour App's fallback chain already
   * covers.
   */
  function handleSelect(id: string) {
    setSelectedId(id);
    onSelected?.(id);
  }

  function handleReverted(newSnapshot: SnapshotManifest) {
    onChanged();
    setSelectedId(newSnapshot.id);
    onSelected?.(newSnapshot.id);
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
          onSelect={handleSelect}
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
