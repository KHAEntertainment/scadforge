// SPDX-License-Identifier: Apache-2.0

// S3-C C4 — the preview adapter core (Issue #136 criterion 1; spec §4.3 and
// §10.2 Q1, Option 1).
//
// The controller owns the state machine and the port; this adapter owns the
// render queue, the "did the geometry for THIS candidate arrive" check, the
// pointer-capture lifecycle and the routing of the six cancel sources. It
// never drives a controller transition other than `cancel(reason)`: it only
// writes samples to the port, and the controller reacts to port state.
//
// Failure B's fix lives in `engineUpdate`: a sample is written only once the
// engine has published the geometry (a new object URL) of the exact request
// this adapter issued for the controller's CURRENT port generation — never
// on a status change alone, and never for a result it cannot attribute.
//
// Attribution: `WasmPreviewClient` debounces each render ~300ms and an
// in-flight older render may still complete inside the next request's
// debounce window. So the queue is one deep: a new request goes to the
// engine only once the previous one settled; the newest wanted render waits
// and older wants are dropped (latest wins).
//
// Framework-free; `usePreviewAdapter.ts` is the React binding.

import type { ParamValues } from "@scadforge/protocol";
import type { TransactionController } from "../controller/controller.js";
import type { BeginInput, CancelReason, ControllerState } from "../controller/types.js";

/** `useWasmPreview`'s status tags (`WasmPreviewStatus["kind"]`). */
export type EngineStatus = "idle" | "pending" | "ok" | "error" | "timeout" | "fatal";

/**
 * One engine output. The binding passes the hook's result object itself, so
 * `identity` changes on every engine event (the hook memoizes its result on
 * its internal status object) while staying stable across unrelated renders.
 */
export interface EngineSnapshot {
  status: EngineStatus;
  objectUrl: string | null;
  identity: object;
}

/** Where a render's inputs came from, so a result is never shown for another project or revision. */
export interface RenderTag {
  projectId: string;
  editorRevision: string;
}

/** What the session wants rendered next. `sample` is set only for a gesture candidate. */
export interface WantedRender {
  scad: string;
  params: ParamValues;
  tag: RenderTag;
  sample: { generation: number; value: number } | null;
}

/** The inputs currently handed to the engine. */
export interface EngineInput {
  scad: string;
  params: ParamValues;
  paramsKey: string;
  tag: RenderTag;
  /** The port generation of the candidate this input was issued for (`null` for a display render). */
  generation: number | null;
}

export type PreviewStatus = "pending" | "ok" | "failed";

/** The adapter's outward view of the render matching the current want. */
export interface PreviewView {
  /** The want this view answers, or `null` when nothing is wanted. */
  tag: RenderTag | null;
  paramsKey: string | null;
  status: PreviewStatus;
  /** The last successful render's URL and the inputs it was rendered from (may lag a pending want). */
  shown: { objectUrl: string; tag: RenderTag; paramsKey: string } | null;
}

interface Settled {
  input: EngineInput;
  ok: boolean;
  objectUrl: string | null;
}

interface Awaiting {
  baselineUrl: string | null;
  identityAtIssue: object | null;
}

interface PointerCapture {
  element: Element;
  pointerId: number;
  detach: () => void;
}

/** Same key `useWasmPreview` re-renders on (`JSON.stringify(params)`). */
export function paramsKey(params: ParamValues): string {
  return JSON.stringify(params);
}

function isActiveGesture(state: ControllerState): state is Extract<ControllerState, { begin: BeginInput }> & {
  kind: "gesture" | "preview-pending" | "preview-ok" | "preview-failed";
} {
  return state.kind === "gesture" || state.kind === "preview-pending" || state.kind === "preview-ok" || state.kind === "preview-failed";
}

export class PreviewAdapter {
  private controller: TransactionController | null = null;
  private want: WantedRender | null = null;
  private input: EngineInput | null = null;
  private awaiting: Awaiting | null = null;
  private settled: Settled | null = null;
  private lastShown: Settled | null = null;
  private lastUrl: string | null = null;
  private lastIdentity: object | null = null;
  /** After a reset, the first engine snapshot is a baseline (whatever the engine still holds), never a result. */
  private rebaseline = false;
  private latchedBegin: BeginInput | null = null;
  private capture: PointerCapture | null = null;
  private view: PreviewView = { tag: null, paramsKey: null, status: "pending", shown: null };
  private disposed = false;

  /**
   * `onChange` fires whenever `engineInput()` or `previewView()` changed;
   * `onRestart` asks the binding to restart the engine (a re-render of inputs
   * the engine already has, which `useWasmPreview` never does by itself).
   */
  constructor(
    private readonly onChange: () => void,
    private readonly onRestart: () => void = () => {}
  ) {}

  // ── wiring ──────────────────────────────────────────────────────────────

  setController(controller: TransactionController | null): void {
    if (this.controller === controller) return;
    this.releasePointer();
    this.controller = controller;
    this.latchedBegin = null;
  }

  /** The inputs the engine should render now (`null`: nothing to render). */
  engineInput(): EngineInput | null {
    return this.input;
  }

  previewView(): PreviewView {
    return this.view;
  }

  setWant(want: WantedRender | null): void {
    if (this.disposed) return;
    this.want = want ? { ...want, params: { ...want.params }, tag: { ...want.tag }, sample: want.sample ? { ...want.sample } : null } : null;
    // A new candidate on inputs whose last render FAILED (perhaps a timeout)
    // gets a fresh attempt rather than the cached failure.
    const settled = this.settled;
    if (
      this.want?.sample &&
      settled &&
      !settled.ok &&
      !this.awaiting &&
      this.matchesWant(settled.input, this.want) &&
      settled.input.generation !== this.want.sample.generation
    ) {
      this.reissue();
      this.onRestart();
      return;
    }
    this.deliver();
    this.pump();
    this.refreshView();
  }

  /** The engine was switched off: everything it rendered is gone. */
  resetEngine(): void {
    this.input = null;
    this.awaiting = null;
    this.settled = null;
    this.lastShown = null;
    this.lastUrl = null;
    this.lastIdentity = null;
    this.rebaseline = true;
    this.refreshView();
    this.onChange();
  }

  /**
   * Retry after a failed render: the engine forgets its results and the
   * current want goes out again. The binding restarts the engine as well,
   * since `useWasmPreview` never re-renders identical inputs by itself.
   */
  reissue(): void {
    if (this.disposed) return;
    this.resetEngine();
    this.pump();
    this.refreshView();
  }

  /** Feed every engine output here (the binding calls it after each engine event). */
  engineUpdate(snapshot: EngineSnapshot): void {
    if (this.disposed) return;
    if (this.rebaseline) {
      this.rebaseline = false;
      this.lastIdentity = snapshot.identity;
      this.lastUrl = snapshot.objectUrl;
      if (this.awaiting) this.awaiting = { baselineUrl: snapshot.objectUrl, identityAtIssue: snapshot.identity };
      return;
    }
    const changed = snapshot.identity !== this.lastIdentity;
    this.lastIdentity = snapshot.identity;
    const awaiting = this.awaiting;
    const input = this.input;
    if (!awaiting || !input) {
      this.lastUrl = snapshot.objectUrl;
      return;
    }
    if (snapshot.status === "ok" && snapshot.objectUrl !== null && snapshot.objectUrl !== awaiting.baselineUrl) {
      // The geometry of the request we issued exists now: the only point at
      // which its sample may reach the port (Failure B).
      this.lastUrl = snapshot.objectUrl;
      this.settle({ input, ok: true, objectUrl: snapshot.objectUrl });
      return;
    }
    const failed = snapshot.status === "error" || snapshot.status === "timeout" || snapshot.status === "fatal";
    // A failure counts only if it is a NEW engine event after the request
    // went out; an `error` left over from the previous request does not.
    if (failed && changed && snapshot.identity !== awaiting.identityAtIssue) {
      this.settle({ input, ok: false, objectUrl: null });
      return;
    }
    if (snapshot.objectUrl !== null) this.lastUrl = snapshot.objectUrl;
  }

  // ── cancel sources (spec §3.4) ───────────────────────────────────────────

  /**
   * Routes one cancel source to `controller.cancel(reason)`, at most once per
   * gesture (keyed by the gesture's `begin` object) and only while a gesture
   * is active — so a commit in flight is never detached by a cancel source.
   */
  cancel(reason: CancelReason): boolean {
    const controller = this.controller;
    if (!controller) return false;
    const state = controller.state();
    if (!isActiveGesture(state)) return false;
    if (this.latchedBegin === state.begin) return false;
    this.latchedBegin = state.begin;
    this.releasePointer();
    controller.cancel(reason);
    return true;
  }

  /** True while the controller holds an active gesture (gesture … preview-failed). */
  gestureActive(): boolean {
    const state = this.controller?.state();
    return state ? isActiveGesture(state) : false;
  }

  // ── pointer-capture lifecycle (reused by the S4-B handle) ────────────────

  /**
   * Takes pointer capture for a drag and turns the browser's two involuntary
   * endings (`pointercancel`, `lostpointercapture`) into cancels.
   */
  capturePointer(element: Element, pointerId: number): void {
    this.releasePointer();
    const onPointerCancel = () => {
      this.cancel("pointercancel");
    };
    const onLostCapture = () => {
      this.cancel("lostpointercapture");
    };
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("lostpointercapture", onLostCapture);
    this.capture = {
      element,
      pointerId,
      detach: () => {
        element.removeEventListener("pointercancel", onPointerCancel);
        element.removeEventListener("lostpointercapture", onLostCapture);
      }
    };
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // No active pointer with this id (a synthetic event); the listeners still apply.
    }
  }

  /** An intentional release: listeners go first, so the release itself is not read as `lostpointercapture`. */
  releasePointer(): void {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    capture.detach();
    try {
      if (capture.element.hasPointerCapture?.(capture.pointerId)) capture.element.releasePointerCapture(capture.pointerId);
    } catch {
      // Already released by the browser.
    }
  }

  hasPointerCapture(): boolean {
    return this.capture !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.releasePointer();
    this.controller = null;
  }

  // ── internal ─────────────────────────────────────────────────────────────

  private settle(result: Settled): void {
    this.awaiting = null;
    this.settled = result;
    if (result.ok) this.lastShown = result;
    this.deliver();
    this.pump();
    this.refreshView();
  }

  /** Writes the settled render to the port iff it is the current candidate at the current generation. */
  private deliver(): void {
    const want = this.want;
    const settled = this.settled;
    const controller = this.controller;
    if (!want?.sample || !settled || !controller || !this.matchesWant(settled.input, want)) return;
    const state = controller.state();
    if (state.kind !== "preview-pending") return;
    if (state.portGeneration !== want.sample.generation || state.candidate.value !== want.sample.value) return;
    if (settled.ok) controller.portWriter.write({ value: want.sample.value, generation: want.sample.generation });
    else controller.portWriter.fail(want.sample.generation);
  }

  /** Issues the current want to the engine if nothing is in flight and the engine is not already on it. */
  private pump(): void {
    const want = this.want;
    if (!want || this.awaiting) return;
    if (this.input && this.matchesWant(this.input, want)) return;
    this.input = {
      scad: want.scad,
      params: want.params,
      paramsKey: paramsKey(want.params),
      tag: want.tag,
      generation: want.sample ? want.sample.generation : null
    };
    this.awaiting = { baselineUrl: this.lastUrl, identityAtIssue: this.lastIdentity };
    this.onChange();
  }

  private matchesWant(input: EngineInput, want: WantedRender): boolean {
    return input.scad === want.scad && input.paramsKey === paramsKey(want.params) && input.tag.projectId === want.tag.projectId;
  }

  private refreshView(): void {
    const want = this.want;
    const settled = this.settled;
    const status: PreviewStatus =
      want && settled && !this.awaiting && this.matchesWant(settled.input, want) ? (settled.ok ? "ok" : "failed") : "pending";
    const shown = this.lastShown?.objectUrl
      ? { objectUrl: this.lastShown.objectUrl, tag: this.lastShown.input.tag, paramsKey: this.lastShown.input.paramsKey }
      : null;
    const next: PreviewView = { tag: want ? want.tag : null, paramsKey: want ? paramsKey(want.params) : null, status, shown };
    const prev = this.view;
    if (
      prev.status === next.status &&
      prev.paramsKey === next.paramsKey &&
      prev.tag?.projectId === next.tag?.projectId &&
      prev.tag?.editorRevision === next.tag?.editorRevision &&
      prev.shown?.objectUrl === next.shown?.objectUrl &&
      prev.shown?.tag.editorRevision === next.shown?.tag.editorRevision
    ) {
      return;
    }
    this.view = next;
    this.onChange();
  }
}
