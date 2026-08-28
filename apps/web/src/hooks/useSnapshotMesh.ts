import { useEffect, useState } from "react";
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
  const [result, setResult] = useState<UseSnapshotMeshResult>({ url: null, status: "idle" });

  useEffect(() => {
    if (!projectId || !snapshotId) {
      setResult({ url: null, status: "idle" });
      return;
    }

    let cancelled = false;
    const path = meshPath(projectId, snapshotId);
    const url = client.resolveUrl(path);
    setResult({ url: null, status: "checking" });

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
        setResult(ok ? { url, status: "ready" } : { url: null, status: "absent" });
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ url: null, status: "absent" });
      });

    return () => {
      cancelled = true;
    };
  }, [client, projectId, snapshotId]);

  return result;
}
