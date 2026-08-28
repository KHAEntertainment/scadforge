import type { SnapshotManifest } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";
import { ExportButton } from "./ExportButton.js";
import { HistoryPanel } from "./history/HistoryPanel.js";

export interface HistoryTabProps {
  client: ApiClient;
  projectId: string | null;
  snapshots: SnapshotManifest[];
  loading: boolean;
  error: string | null;
  onExported: () => void;
  /** Reports the selected snapshot up to `App`, which previews it (Issue #41). */
  onSelectSnapshot?: (id: string) => void;
}

/**
 * SDP §9 History tab: snapshot list with thumbnails/badges, diff vs parent,
 * and "Revert to this" (Issue #34), plus the existing export action (Issue
 * #18). Revert and export both refresh the shared snapshot list via
 * `onExported` (the callback name predates revert; it simply means "the
 * snapshot list may have changed, refetch it").
 */
export function HistoryTab({
  client,
  projectId,
  snapshots,
  loading,
  error,
  onExported,
  onSelectSnapshot
}: HistoryTabProps) {
  return (
    <div className="history-tab">
      <ExportButton client={client} projectId={projectId} onExported={onExported} />
      <HistoryPanel
        client={client}
        projectId={projectId}
        snapshots={snapshots}
        loading={loading}
        error={error}
        onChanged={onExported}
        onSelected={onSelectSnapshot}
      />
    </div>
  );
}
