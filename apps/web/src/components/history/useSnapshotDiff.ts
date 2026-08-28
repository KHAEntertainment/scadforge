import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/apiClient.js";

export interface UseSnapshotDiffResult {
  /** `null` before a snapshot is selected or while a new selection is loading for the first time. */
  diff: string | null;
  parentId: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches `GET /snapshots/:id/diff` for the selected snapshot. Per the frozen
 * contract, `diff` is `""` (not `null`) for the first snapshot — this hook
 * only uses `null` to mean "nothing selected yet / not loaded".
 */
export function useSnapshotDiff(client: ApiClient, projectId: string | null, snapshotId: string | null): UseSnapshotDiffResult {
  const [diff, setDiff] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !snapshotId) {
      setDiff(null);
      setParentId(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .getSnapshotDiff(projectId, snapshotId)
      .then((res) => {
        if (cancelled) return;
        setDiff(res.diff);
        setParentId(res.parent);
      })
      .catch((cause) => {
        if (cancelled) return;
        setDiff(null);
        setError(cause instanceof Error ? cause.message : "Failed to load diff.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId, snapshotId]);

  return { diff, parentId, loading, error };
}
