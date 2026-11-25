import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../lib/apiClient.js";

/** Path template for a snapshot's persisted mesh — mirrors `apps/server`'s `SNAPSHOT_MESH_ROUTE`. */
function meshPath(projectId: string, snapshotId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}/mesh`;
}

export type SnapshotMeshStatus = "idle" | "checking" | "ready" | "absent";

export interface UseSnapshotMeshResult {
  /** URL to hand `<Viewer3D stlUrl>`; null unless a mesh actually exists. */
  url: string | null;
  status: SnapshotMeshStatus;
  /**
   * The project and snapshot this result was requested for (`null` while idle),
   * set in the same update as `url`/`status`, so a caller can tell a result
   * left over from a previous project or selection from the current one.
   * Optional so existing stand-ins without them still type-check.
   */
  projectId?: string | null;
  snapshotId?: string | null;
  /**
   * Probe the mesh again for the project/snapshot this result already names —
   * Issue #143: a Build can attach a mesh to the snapshot that is already
   * current, and then nothing about the selection changes to trigger a probe.
   * Optional so existing stand-ins without it still type-check.
   */
  reprobe?: () => void;
}

/**
 * Resolves the 3D-viewer mesh URL for one snapshot (Issue #41).
 *
 * This is the piece that makes the viewer work from PERSISTED state: the old
 * code read `stlUrl` off live chat state alone, so picking a snapshot in
 * History showed nothing and a page refresh blanked the preview even though
 * renders existed on disk.
 *
 * It probes before handing the URL over rather than letting `STLLoader` find
 * out the hard way. A snapshot with no mesh is an ordinary, expected state
 * (nothing has validated it yet), and it should read as a plain explanation,
 * not as the error boundary's "couldn't load the model" — which is what an
 * unchecked 404 inside the loader would produce.
 */
export function useSnapshotMesh(
  client: ApiClient,
  projectId: string | null,
  snapshotId: string | null
): UseSnapshotMeshResult {
  const [result, setResult] = useState<UseSnapshotMeshResult>({ url: null, status: "idle", projectId: null, snapshotId: null });
  // Issue #143: the explicit re-probe trigger. Bumping this re-runs the effect
  // for the SAME identity; `reprobe` stays stable across renders.
  const [probe, setProbe] = useState(0);
  const reprobe = useCallback(() => setProbe((n) => n + 1), []);

  useEffect(() => {
    if (!projectId || !snapshotId) {
      setResult({ url: null, status: "idle", projectId: null, snapshotId: null });
      return;
    }

    let cancelled = false;
    const path = meshPath(projectId, snapshotId);
    const url = client.resolveUrl(path);
    // A selection change starts at `checking` as before. A re-probe of the
    // identity the result already holds keeps that result until the new answer
    // lands — a Build on an already-built head must not flash `checking` (and
    // with it the local preview) between two `ready` answers.
    setResult((prev) =>
      prev.projectId === projectId && prev.snapshotId === snapshotId
        ? prev
        : { url: null, status: "checking", projectId, snapshotId }
    );

    // `HEAD` so a rapid click through History never pulls several multi-MB
    // STL bodies down just to discover which snapshots have one. The GET that
    // actually streams the mesh is issued by `STLLoader`, once, for the
    // snapshot that ends up selected.
    client
      .headRaw(path)
      .then((ok) => {
        // `cancelled` is the guard against out-of-order replies: switching
        // snapshots quickly can land an older probe after a newer one, and
        // without this the viewer would settle on the wrong snapshot's answer.
        if (cancelled) return;
        setResult(ok ? { url, status: "ready", projectId, snapshotId } : { url: null, status: "absent", projectId, snapshotId });
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ url: null, status: "absent", projectId, snapshotId });
      });

    return () => {
      cancelled = true;
    };
  }, [client, projectId, snapshotId, probe]);

  return useMemo(() => ({ ...result, reprobe }), [result, reprobe]);
}
