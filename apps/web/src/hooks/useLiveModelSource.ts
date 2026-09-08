import { useEffect, useState } from "react";
import type { ParamValues } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

export interface LiveModelSource {
  /** Project whose source was fetched; prevents cross-project preview reuse. */
  projectId: string | null;
  /** Head revision used for the fetch; a changed head is stale until refetched. */
  headSnapshotId: string | null;
  /** Current `model.scad` text; null until the first successful fetch. */
  scad: string | null;
  params: ParamValues;
}

const EMPTY: LiveModelSource = { projectId: null, headSnapshotId: null, scad: null, params: {} };

/**
 * Re-fetches the project's current `model.scad` + params whenever the head
 * snapshot changes (a new chat turn, a manual save, a revert…), so the WASM
 * live preview (Issue #31) always compiles the latest source. This hook only
 * talks to the REST API — it does not import anything from `wasm/**`.
 */
export function useLiveModelSource(
  client: ApiClient,
  projectId: string | null,
  headSnapshotId: string | null
): LiveModelSource {
  const [source, setSource] = useState<LiveModelSource>(EMPTY);

  useEffect(() => {
    if (!projectId) {
      setSource(EMPTY);
      return;
    }
    // Clear provenance on every project/head transition. Keeping a prior
    // project's source here would let Live compile the wrong model while the
    // new request is pending or fails.
    setSource({ projectId, headSnapshotId, scad: null, params: {} });
    let cancelled = false;
    client
      .getProject(projectId)
      .then((res) => {
        if (cancelled) return;
        setSource({ projectId, headSnapshotId, scad: res.scad, params: res.params });
      })
      .catch(() => {
        // Keep the selected project's source unavailable after a failed fetch;
        // a stale source is more dangerous than a temporarily disabled Live
        // toggle.
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId, headSnapshotId]);

  return source;
}
