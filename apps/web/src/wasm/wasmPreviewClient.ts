// GPL ZONE — Issue #31.
//
// Main-thread client for the openscad-wasm preview Worker. Owns:
//   - ~300ms debounce on `render()` calls (AC: debounced on param change)
//   - stale-result rejection by requestId (AC: a superseded render never wins)
//   - a render timeout, defaulting to server-authority fallback semantics
//     (CLAUDE.md hard rule 6 / PROJECT_CONTEXT.md "Render authority" — this
//     client only ever reports its OWN pending/ok/error/timeout state; it is
//     the caller's job, e.g. `useWasmPreview`, to keep showing the last
//     server render underneath while this reports non-`ok`)
//   - true cancellation of a still-running render: a synchronous `callMain`
//     inside the worker cannot be interrupted cooperatively, so a superseded
//     or timed-out render is cancelled by terminating the whole Worker and
//     lazily spawning a fresh one for the next request.
//
// This file imports the GPL-derived worker only via `new Worker(new URL(...))`
// (a URL reference, not a symbol import) — no openscad-wasm glue code is
// pulled into this module or anything that imports it.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ParamValues } from "@scadforge/protocol";
import type { WasmWorkerMessage } from "./protocol.js";

export type WasmPreviewStatus =
  | { kind: "idle" }
  | { kind: "pending"; requestId: string }
  | { kind: "ok"; requestId: string; stl: ArrayBuffer; ms: number; wasmHeapBytes: number }
  | { kind: "error"; requestId: string; stderr: string; ms: number }
  | { kind: "timeout"; requestId: string }
  | { kind: "fatal"; requestId: string | null; message: string };

export interface WasmPreviewClientOptions {
  /** Debounce interval between a `render()` call and the actual worker post. Default 300ms (AC). */
  debounceMs?: number;
  /** Wall-clock budget for one render before it's treated as a timeout. Default 8000ms. */
  timeoutMs?: number;
  /** Injectable for tests — defaults to spawning the real openscad.worker.ts module worker. */
  createWorker?: () => Worker;
  /** Injectable clock for deterministic debounce/timeout tests. */
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

type Listener = (status: WasmPreviewStatus) => void;

function defaultCreateWorker(): Worker {
  return new Worker(new URL("./openscad.worker.ts", import.meta.url), { type: "module" });
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `wasm-render-${requestCounter}-${Date.now()}`;
}

/**
 * One client instance == one long-lived Worker slot, re-spawned whenever a
 * render is superseded or times out. Callers should keep a single instance
 * alive for the lifetime of the preview UI (see `useWasmPreview`).
 */
export class WasmPreviewClient {
  private readonly debounceMs: number;
  private readonly timeoutMs: number;
  private readonly createWorker: () => Worker;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private worker: Worker | null = null;
  private listeners = new Set<Listener>();
  private status: WasmPreviewStatus = { kind: "idle" };
  /** Instrumentation only (not preview status) — surfaced for the cold-init AC measurement. */
  private coldInit: { moduleLoadMs: number; bosl2FileCount: number; bosl2SourceBytes: number } | null = null;

  /** The requestId of the most recent `render()` call — a worker reply for any other id is stale and ignored. */
  private latestRequestId: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: WasmPreviewClientOptions = {}) {
    this.debounceMs = options.debounceMs ?? 300;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    // `.bind(globalThis)` is load-bearing, not stylistic: these are stored on
    // the instance and later invoked as `this.setTimeoutFn(...)`, i.e. with the
    // client as the receiver. A browser's native setTimeout/clearTimeout are
    // branded Window methods and throw `TypeError: Illegal invocation` for any
    // receiver other than the global. jsdom's are plain functions and tolerate
    // it, so this only ever blew up in a real browser (it unmounted the whole
    // React root the moment Preview's "Live" button was clicked).
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout.bind(globalThis);
  }

  getStatus(): WasmPreviewStatus {
    return this.status;
  }

  /** Non-null once the worker's module + BOSL2 bundle have loaded at least once. */
  getColdInit(): { moduleLoadMs: number; bosl2FileCount: number; bosl2SourceBytes: number } | null {
    return this.coldInit;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: WasmPreviewStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /**
   * Requests a render of `scad` with `params`. Debounced ~300ms; calling this
   * again before the debounce fires simply reschedules (only the last call in
   * a burst is ever sent to the worker) — covers "rapid successive param
   * changes" (AC / self-check counterexample).
   */
  render(scad: string, params: ParamValues): void {
    if (this.disposed) return;
    if (this.debounceTimer !== null) this.clearTimeoutFn(this.debounceTimer);
    this.debounceTimer = this.setTimeoutFn(() => {
      this.debounceTimer = null;
      this.startRender(scad, params);
    }, this.debounceMs);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<WasmWorkerMessage>) => this.handleWorkerMessage(event.data);
    worker.onerror = (event: ErrorEvent) => {
      this.setStatus({ kind: "fatal", requestId: this.latestRequestId, message: event.message });
      this.respawnWorker();
    };
    this.worker = worker;
    return worker;
  }

  /** Cancels whatever the worker is doing (if anything) by discarding it entirely — see file header. */
  private respawnWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private startRender(scad: string, params: ParamValues) {
    // A render is in flight iff we're still waiting on latestRequestId — a
    // new call superseding it means the in-flight one loses regardless of
    // what it eventually returns (AC: "no stale mesh wins"). Since a
    // synchronous callMain can't be interrupted cooperatively, the only real
    // cancellation is discarding the whole worker.
    const wasPending = this.status.kind === "pending";
    if (wasPending) this.respawnWorker();
    if (this.timeoutTimer !== null) {
      this.clearTimeoutFn(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    const requestId = nextRequestId();
    this.latestRequestId = requestId;
    this.setStatus({ kind: "pending", requestId });

    const worker = this.ensureWorker();
    worker.postMessage({ type: "render", requestId, scad, params });

    this.timeoutTimer = this.setTimeoutFn(() => {
      this.timeoutTimer = null;
      if (this.latestRequestId !== requestId) return; // already superseded
      this.setStatus({ kind: "timeout", requestId });
      this.respawnWorker(); // true cancellation of the hung render
    }, this.timeoutMs);
  }

  private handleWorkerMessage(msg: WasmWorkerMessage) {
    if (msg.type === "cold-init") {
      this.coldInit = {
        moduleLoadMs: msg.moduleLoadMs,
        bosl2FileCount: msg.bosl2FileCount,
        bosl2SourceBytes: msg.bosl2SourceBytes
      };
      return; // instrumentation only — not preview status
    }

    // Stale-result rejection: a reply for anything but the current
    // latestRequestId is ignored outright (AC: superseded render never wins).
    if (msg.requestId !== this.latestRequestId) return;

    if (this.timeoutTimer !== null) {
      this.clearTimeoutFn(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    if (msg.type === "result") {
      if (msg.ok) {
        this.setStatus({ kind: "ok", requestId: msg.requestId, stl: msg.stl, ms: msg.ms, wasmHeapBytes: msg.wasmHeapBytes });
      } else {
        this.setStatus({ kind: "error", requestId: msg.requestId, stderr: msg.stderr, ms: msg.ms });
      }
    } else if (msg.type === "fatal") {
      this.setStatus({ kind: "fatal", requestId: msg.requestId, message: msg.message });
      this.respawnWorker();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== null) this.clearTimeoutFn(this.debounceTimer);
    if (this.timeoutTimer !== null) this.clearTimeoutFn(this.timeoutTimer);
    this.respawnWorker();
    this.listeners.clear();
  }
}
