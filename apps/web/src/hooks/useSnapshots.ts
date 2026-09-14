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
  const [trackedProjectId, setTrackedProjectId] = useState(projectId);

  // Issue #79: reset synchronously, DURING RENDER, the instant `projectId`
  // changes (React's supported "adjust state when a prop changes" pattern),
  // instead of waiting for the fetch effect below to run. A project switch
  // must never let the FIRST render with the new `projectId` still carry the
  // previous project's snapshots — `App.tsx`'s derived `workingHead` reads
  // this array on every render, and a stale array there is exactly what let
  // the old project's snapshot id (and mesh request) leak into the new
  // project for a render or more.
  if (projectId !== trackedProjectId) {
    setTrackedProjectId(projectId);
    setSnapshots([]);
    setError(null);
  }

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
