import { useEffect, useState } from "react";
import type { BufferGeometry } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

/** Each mounted viewer owns its geometry; no module-global loader cache. */
export function useStlGeometry(url: string): BufferGeometry | null {
  const [loaded, setLoaded] = useState<{ url: string; geometry: BufferGeometry; lease: { active: boolean } } | null>(null);
  const [failure, setFailure] = useState<{ url: string; error: Error; lease: { active: boolean } } | null>(null);
  useEffect(() => {
    const lease = { active: true };
    let owned: BufferGeometry | null = null;
    new STLLoader().load(url, (geometry) => {
      // A superseded or StrictMode-cleaned-up request still owns its result.
      if (!lease.active) {
        geometry.dispose();
        return;
      }
      owned = geometry;
      setLoaded({ url, geometry, lease });
    }, undefined, (error) => {
      if (lease.active) setFailure({ url, error: error instanceof Error ? error : new Error("STL load failed"), lease });
    });
    return () => {
      lease.active = false;
      owned?.dispose();
    };
  }, [url]);
  if (failure?.url === url && failure.lease.active) throw failure.error;
  return loaded?.url === url && loaded.lease.active ? loaded.geometry : null;
}
