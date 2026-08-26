import { useCallback, useEffect, useState } from "react";
import type { SnapshotManifest } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

export interface UseSnapshotsResult {
  snapshots: SnapshotManifest[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Fetches `GET /snapshots`, newest first, per the frozen `ListSnapshotsResponse`. */
export function useSnapshots(client: ApiClient, projectId: string | null): UseSnapshotsResult {
  const [snapshots, setSnapshots] = useState<SnapshotManifest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .listSnapshots(projectId)
      .then((res) => {
        if (!cancelled) setSnapshots(res.snapshots);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Failed to load snapshots.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  return { snapshots, loading, error, refresh };
}
