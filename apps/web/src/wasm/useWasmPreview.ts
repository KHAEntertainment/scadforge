// GPL ZONE — Issue #31.
//
// React seam onto `WasmPreviewClient`. This is the intended import for code
// outside `apps/web/src/wasm/**` (PreviewTab) — it exposes only plain
// data (a status tag + an object URL), never a Worker/GPL glue reference.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import type { ParamValues } from "@scadforge/protocol";
import { WasmPreviewClient, type WasmPreviewStatus } from "./wasmPreviewClient.js";

export interface UseWasmPreviewResult {
  status: WasmPreviewStatus["kind"];
  /** `URL.createObjectURL` of the latest successful STL — null until the first successful render. Feed straight into `<Viewer3D stlUrl>`. */
  objectUrl: string | null;
  /** OpenSCAD stderr for the most recent failed render (AC: surfaced to the UI verbatim). */
  stderr: string | null;
  /** Most recent successful render's wall time, ms. */
  lastRenderMs: number | null;
  coldInit: { moduleLoadMs: number; bosl2FileCount: number; bosl2SourceBytes: number } | null;
}

/**
 * Drives a live WASM preview of `scad`+`params` using an existing
 * `WasmPreviewClient`. Split out from {@link useWasmPreview} so tests can
 * inject a client with a fake `createWorker` instead of spawning a real
 * Worker (unavailable under jsdom).
 */
export function useWasmPreviewWithClient(
  client: WasmPreviewClient | null,
  scad: string | null,
  params: ParamValues,
  enabled: boolean
): UseWasmPreviewResult {
  const [status, setStatus] = useState<WasmPreviewStatus>({ kind: "idle" });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [coldInit, setColdInit] = useState<UseWasmPreviewResult["coldInit"]>(null);

  useEffect(() => {
    if (!enabled || !client) return;
    const unsubscribe = client.subscribe((next) => {
      setStatus(next);
      if (next.kind === "ok") {
        const blob = new Blob([next.stl], { type: "model/stl" });
        const url = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setObjectUrl(url);
        setColdInit(client.getColdInit());
      }
    });
    return () => {
      unsubscribe();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setObjectUrl(null);
      setStatus({ kind: "idle" });
    };
  }, [client, enabled]);

  useEffect(() => {
    if (!enabled || !client || scad === null) return;
    client.render(scad, params);
    // `params` is a plain object recreated per caller render; depending on its
    // JSON keeps this effect from re-firing (and re-debouncing) on referential
    // churn alone, only on an actual value change. `params` itself is
    // intentionally omitted from the dep array for that reason.
  }, [client, enabled, scad, JSON.stringify(params)]);

  return useMemo(
    () => ({
      status: status.kind,
      objectUrl,
      stderr: status.kind === "error" ? status.stderr : null,
      lastRenderMs: status.kind === "ok" ? status.ms : null,
      coldInit
    }),
    [status, objectUrl, coldInit]
  );
}

/**
 * Drives a live WASM preview of `scad`+`params`. `enabled: false` (the
 * default preview mode is the server-authoritative view — Live is opt-in per
 * PreviewTab) skips spawning the worker entirely. Owns one `WasmPreviewClient`
 * (and its Worker) for the lifetime of `enabled: true`.
 */
export function useWasmPreview(scad: string | null, params: ParamValues, enabled: boolean): UseWasmPreviewResult {
  const clientRef = useRef<WasmPreviewClient | null>(null);
  const [client, setClient] = useState<WasmPreviewClient | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const instance = new WasmPreviewClient();
    clientRef.current = instance;
    setClient(instance);
    return () => {
      instance.dispose();
      clientRef.current = null;
      setClient(null);
    };
  }, [enabled]);

  return useWasmPreviewWithClient(client, scad, params, enabled);
}
