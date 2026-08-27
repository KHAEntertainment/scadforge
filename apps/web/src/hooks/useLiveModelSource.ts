import { useEffect, useState } from "react";
import type { ParamValues } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

export interface LiveModelSource {
  /** Current `model.scad` text; null until the first successful fetch. */
  scad: string | null;
  params: ParamValues;
}

const EMPTY: LiveModelSource = { scad: null, params: {} };

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
    let cancelled = false;
    client
      .getProject(projectId)
      .then((res) => {
        if (cancelled) return;
        setSource({ scad: res.scad, params: res.params });
      })
      .catch(() => {
        // Best-effort: keep whatever source we already had rather than
        // clearing it — a transient fetch failure should not blank the Live
        // preview toggle (it'll just keep showing the previous compile, or
        // stay disabled if there was never a successful fetch).
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId, headSnapshotId]);

  return source;
}
