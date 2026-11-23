// SPDX-License-Identifier: Apache-2.0

// S3-C C4 — React binding for the preview adapter (Issue #136 criterion 1).
//
// Owns the WASM render queue through `useWasmPreview`, imported only from the
// GPL-zone facade `apps/web/src/wasm/index.ts`; the engine hook is injectable
// so tests can drive a controllable fake instead of a Worker. Also owns two of
// the six cancel sources that live on `window` (Escape, blur), registered only
// while a gesture is active. Pointer capture, tool change and unmount are
// exposed as calls for their owners (the S4-B handle, the Workspace tab, the
// Edit surface).

import { useEffect, useMemo, useRef, useState } from "react";
import type { ParamValues } from "@scadforge/protocol";
import { useWasmPreview } from "../../../wasm/index.js";
import type { TransactionController } from "../controller/controller.js";
import type { CancelReason, ControllerState } from "../controller/types.js";
import { PreviewAdapter, type EngineStatus, type PreviewView, type WantedRender } from "./previewAdapter.js";

/** The engine hook's shape (a subset of `useWasmPreview`'s). Must be referentially stable for the component's life. */
export type PreviewEngineHook = (
  scad: string | null,
  params: ParamValues,
  enabled: boolean
) => { status: EngineStatus; objectUrl: string | null };

export interface UsePreviewAdapterOptions {
  controller: TransactionController | null;
  /** The controller's live state (drives the window listeners). */
  state: ControllerState;
  want: WantedRender | null;
  /** Whether the adapter's engine (worker) should be alive. */
  enabled: boolean;
  engine?: PreviewEngineHook;
}

export interface PreviewAdapterHandle {
  view: PreviewView;
  /** Routes one cancel source; at most once per gesture, only while a gesture is active. */
  cancel(reason: CancelReason): boolean;
  /** The Workspace left the Edit tool. */
  notifyToolChange(): void;
  capturePointer(element: Element, pointerId: number): void;
  releasePointer(): void;
  /** Re-render the current want from scratch (Retry after a display failure). */
  retry(): void;
}

const EMPTY_PARAMS: ParamValues = {};

function isActiveGestureKind(kind: ControllerState["kind"]): boolean {
  return kind === "gesture" || kind === "preview-pending" || kind === "preview-ok" || kind === "preview-failed";
}

export function usePreviewAdapter({ controller, state, want, enabled, engine = useWasmPreview }: UsePreviewAdapterOptions): PreviewAdapterHandle {
  // The engine hook is fixed at first render (hooks cannot be swapped).
  const engineRef = useRef(engine);
  const useEngine = engineRef.current;

  const [version, setVersion] = useState(0);
  // One render with the engine off makes `useWasmPreview` start a fresh worker for a retry.
  const [restarting, setRestarting] = useState(false);
  const adapterRef = useRef<PreviewAdapter | null>(null);
  if (!adapterRef.current) {
    adapterRef.current = new PreviewAdapter(
      () => setVersion((v) => v + 1),
      () => setRestarting(true)
    );
  }
  const adapter = adapterRef.current;

  useEffect(() => {
    adapter.setController(controller);
    // Unmount (or StrictMode's practice cleanup, which re-runs this setup):
    // drop pointer capture and the controller reference.
    return () => adapter.setController(null);
  }, [adapter, controller]);

  useEffect(() => {
    adapter.setWant(enabled ? want : null);
  }, [adapter, want, enabled]);

  // `version` re-reads the adapter after it asked the engine for new inputs.
  const input = useMemo(() => adapter.engineInput(), [adapter, version]);
  const engineOn = enabled && !restarting;
  const result = useEngine(input?.scad ?? null, input?.params ?? EMPTY_PARAMS, engineOn);

  useEffect(() => {
    if (restarting) setRestarting(false);
  }, [restarting]);

  useEffect(() => {
    if (!enabled) adapter.resetEngine();
  }, [adapter, enabled]);

  // The result object itself is the event identity (see `EngineSnapshot`).
  useEffect(() => {
    if (!engineOn) return;
    adapter.engineUpdate({ status: result.status, objectUrl: result.objectUrl, identity: result });
  }, [adapter, engineOn, result]);

  const gestureActive = isActiveGestureKind(state.kind);

  // Escape and window blur: only while a gesture is active (spec §3.4).
  useEffect(() => {
    if (!gestureActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") adapter.cancel("escape");
    };
    const onBlur = () => {
      adapter.cancel("window-blur");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [adapter, gestureActive]);

  // Read on every render; `version` changes whenever the adapter's view did.
  const view = useMemo(() => adapter.previewView(), [adapter, version]);

  return useMemo(
    () => ({
      view,
      cancel: (reason: CancelReason) => adapter.cancel(reason),
      notifyToolChange: () => {
        adapter.cancel("tool-change");
      },
      capturePointer: (element: Element, pointerId: number) => adapter.capturePointer(element, pointerId),
      releasePointer: () => adapter.releasePointer(),
      retry: () => {
        adapter.reissue();
        setRestarting(true);
      }
    }),
    [adapter, view]
  );
}
