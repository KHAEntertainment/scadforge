import type { SnapshotManifest } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";
import { ExportButton } from "./ExportButton.js";
import { SnapshotList } from "./SnapshotList.js";

export interface HistoryTabProps {
  client: ApiClient;
  projectId: string | null;
  snapshots: SnapshotManifest[];
  loading: boolean;
  error: string | null;
  onExported: () => void;
}

/**
 * SDP §9 History tab. Diff/revert UI is out of scope for Issue #18 (M2) — this
 * is the snapshot list + export action only.
 */
export function HistoryTab({ client, projectId, snapshots, loading, error, onExported }: HistoryTabProps) {
  return (
    <div className="history-tab">
      <ExportButton client={client} projectId={projectId} onExported={onExported} />
      <SnapshotList snapshots={snapshots} loading={loading} error={error} />
    </div>
  );
}
