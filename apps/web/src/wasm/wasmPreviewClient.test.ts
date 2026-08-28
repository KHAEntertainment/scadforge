import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WasmPreviewClient } from "./wasmPreviewClient.js";
import type { WasmWorkerMessage } from "./protocol.js";

/** Records every posted message and lets the test simulate worker replies. */
class FakeWorker {
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<WasmWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(msg: unknown) {
    this.posted.push(msg);
  }

  terminate() {
    this.terminated = true;
  }

  /** Test helper: simulate the worker replying. */
  reply(msg: WasmWorkerMessage) {
    this.onmessage?.({ data: msg } as MessageEvent<WasmWorkerMessage>);
  }
}

function makeClient(overrides: Partial<{ debounceMs: number; timeoutMs: number }> = {}) {
  const workers: FakeWorker[] = [];
  const client = new WasmPreviewClient({
    debounceMs: overrides.debounceMs ?? 300,
    timeoutMs: overrides.timeoutMs ?? 8000,
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    }
  });
  return { client, workers };
}

describe("WasmPreviewClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces rapid successive render() calls into a single worker post (AC: ~300ms debounce)", () => {
    const { client, workers } = makeClient();

    client.render("cube(1);", {});
    vi.advanceTimersByTime(100);
    client.render("cube(2);", {});
    vi.advanceTimersByTime(100);
    client.render("cube(3);", {}); // only this last call should ever reach the worker
    expect(workers).toHaveLength(0); // still within debounce window, nothing posted yet

    vi.advanceTimersByTime(300);
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toHaveLength(1);
    expect((workers[0].posted[0] as { scad: string }).scad).toBe("cube(3);");
  });

  it("counterexample: a stale reply for a superseded request is ignored — no stale mesh wins", () => {
    const { client, workers } = makeClient();
    const statuses: string[] = [];
    client.subscribe((s) => statuses.push(s.kind));

    client.render("cube(1);", {});
    vi.advanceTimersByTime(300);
    expect(workers).toHaveLength(1);
    const firstWorker = workers[0];
    const firstRequestId = (firstWorker.posted[0] as { requestId: string }).requestId;

    // Supersede before the first one replies — this must terminate the first
    // worker (true cancellation) and spawn a second one.
    client.render("cube(2);", {});
    vi.advanceTimersByTime(300);
    expect(firstWorker.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    const secondWorker = workers[1];
    const secondRequestId = (secondWorker.posted[0] as { requestId: string }).requestId;
    expect(secondRequestId).not.toBe(firstRequestId);

    // A late reply from the (already-terminated) first worker must be ignored.
    firstWorker.reply({ type: "result", requestId: firstRequestId, ok: true, stl: new ArrayBuffer(4), ms: 10, stdout: "", wasmHeapBytes: 100 });
    expect(client.getStatus().kind).toBe("pending"); // still waiting on the second request

    secondWorker.reply({ type: "result", requestId: secondRequestId, ok: true, stl: new ArrayBuffer(8), ms: 20, stdout: "", wasmHeapBytes: 200 });
    expect(client.getStatus()).toMatchObject({ kind: "ok", requestId: secondRequestId });
  });

  it("surfaces OpenSCAD stderr verbatim on a compile error (AC)", () => {
    const { client, workers } = makeClient();
    client.render("this is not valid scad(", {});
    vi.advanceTimersByTime(300);
    const requestId = (workers[0].posted[0] as { requestId: string }).requestId;

    workers[0].reply({ type: "result", requestId, ok: false, stderr: "ERROR: Parser error", ms: 5 });
    expect(client.getStatus()).toMatchObject({ kind: "error", stderr: "ERROR: Parser error" });
  });

  it("counterexample: a render that never replies is treated as a timeout and the worker is cancelled", () => {
    const { client, workers } = makeClient({ timeoutMs: 1000 });
    client.render("cube(1);", {});
    vi.advanceTimersByTime(300);
    expect(workers).toHaveLength(1);
    expect(client.getStatus().kind).toBe("pending");

    vi.advanceTimersByTime(1000);
    expect(client.getStatus().kind).toBe("timeout");
    expect(workers[0].terminated).toBe(true);
  });

  it("counterexample: a worker-level crash reports fatal and respawns", () => {
    const { client, workers } = makeClient();
    client.render("cube(1);", {});
    vi.advanceTimersByTime(300);
    workers[0].onerror?.({ message: "wasm trap" } as ErrorEvent);
    expect(client.getStatus()).toMatchObject({ kind: "fatal", message: "wasm trap" });
    expect(workers[0].terminated).toBe(true);
  });

  it("captures cold-init instrumentation without surfacing it as preview status", () => {
    const { client, workers } = makeClient();
    client.render("cube(1);", {});
    vi.advanceTimersByTime(300);
    expect(client.getColdInit()).toBeNull();

    workers[0].reply({ type: "cold-init", moduleLoadMs: 42, bosl2FileCount: 56, bosl2SourceBytes: 12345 });
    expect(client.getStatus().kind).toBe("pending"); // unaffected
    expect(client.getColdInit()).toEqual({ moduleLoadMs: 42, bosl2FileCount: 56, bosl2SourceBytes: 12345 });
  });

  it("dispose() terminates the worker and stops delivering further status updates", () => {
    const { client, workers } = makeClient();
    const statuses: string[] = [];
    client.subscribe((s) => statuses.push(s.kind));
    client.render("cube(1);", {});
    vi.advanceTimersByTime(300);
    client.dispose();
    expect(workers[0].terminated).toBe(true);

    const countBefore = statuses.length;
    client.render("cube(2);", {}); // no-op after dispose
    vi.advanceTimersByTime(500);
    expect(statuses.length).toBe(countBefore);
  });
});

/**
 * Regression suite for the "Illegal invocation" crash (real-browser only).
 *
 * Every test above injects `setTimeoutFn`/`clearTimeoutFn`, so none of them
 * exercise the DEFAULT timer functions the app actually ships with. That
 * mattered: the client stores the globals on the instance and invokes them as
 * `this.setTimeoutFn(...)`, and a browser's native setTimeout/clearTimeout are
 * branded Window methods that reject any receiver but the global. jsdom's are
 * plain functions that happily accept the client as `this`, so no jsdom test
 * could ever catch it — clicking Preview → "Live" threw immediately in Chrome
 * and, with no error boundary above it, blanked the entire app.
 *
 * These stand-ins reproduce the browser's receiver check so this class of bug
 * fails here instead of in the browser. They are installed as the real globals
 * (not passed as overrides) so the client takes its default path.
 */
describe("WasmPreviewClient default timer functions (browser-branded globals)", () => {
  interface Scheduled {
    id: number;
    fn: () => void;
    cancelled: boolean;
  }

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let scheduled: Scheduled[];
  let nextTimerId: number;

  /** Mirrors WebIDL: a bare call (`this === undefined`) is fine, `obj.method()` is not. */
  function assertGlobalReceiver(receiver: unknown, name: string) {
    if (receiver !== undefined && receiver !== globalThis) {
      throw new TypeError(`Illegal invocation: ${name} called with a non-global receiver`);
    }
  }

  function brandedSetTimeout(this: unknown, fn: () => void): number {
    assertGlobalReceiver(this, "setTimeout");
    const entry: Scheduled = { id: nextTimerId++, fn, cancelled: false };
    scheduled.push(entry);
    return entry.id;
  }

  function brandedClearTimeout(this: unknown, id?: number): void {
    assertGlobalReceiver(this, "clearTimeout");
    const entry = scheduled.find((e) => e.id === id);
    if (entry) entry.cancelled = true;
  }

  /**
   * Fires the timers pending at call time. Snapshotted first, so a timer a
   * callback schedules (startRender's timeout) waits for the next call rather
   * than running in the same pass.
   */
  function runScheduled() {
    for (const entry of [...scheduled]) {
      if (entry.cancelled) continue;
      entry.cancelled = true; // one-shot, like a real timeout
      entry.fn();
    }
  }

  function makeBrandedClient() {
    const workers: FakeWorker[] = [];
    // No setTimeoutFn/clearTimeoutFn overrides — that is the whole point.
    const client = new WasmPreviewClient({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as Worker;
      }
    });
    return { client, workers };
  }

  beforeEach(() => {
    scheduled = [];
    nextTimerId = 1;
    globalThis.setTimeout = brandedSetTimeout as unknown as typeof setTimeout;
    globalThis.clearTimeout = brandedClearTimeout as unknown as typeof clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  it("sanity: the branded stand-ins reject a non-global receiver the way a browser does", () => {
    const holder = { fn: globalThis.setTimeout };
    expect(() => holder.fn(() => {}, 0)).toThrow(/Illegal invocation/);
    expect(() => globalThis.setTimeout(() => {}, 0)).not.toThrow(); // bare call is fine
  });

  it("render() schedules its debounce through the default globals without an Illegal invocation crash", () => {
    const { client, workers } = makeBrandedClient();

    // Pre-fix this threw `TypeError: Illegal invocation` synchronously here,
    // inside useWasmPreview's effect, unmounting the whole React root.
    expect(() => client.render("cube(1);", {})).not.toThrow();
    expect(scheduled).toHaveLength(1); // the debounce timer

    // Firing the debounce runs startRender, which clears + sets the timeout timer.
    expect(() => runScheduled()).not.toThrow();
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toHaveLength(1);
  });

  it("a superseding render(), a worker reply, and dispose() all clear timers through the default globals", () => {
    const { client, workers } = makeBrandedClient();

    client.render("cube(1);", {});
    expect(() => client.render("cube(2);", {})).not.toThrow(); // clearTimeout on the debounce timer
    runScheduled();
    expect(workers).toHaveLength(1);
    const requestId = (workers[0].posted[0] as { requestId: string }).requestId;

    // handleWorkerMessage clears the timeout timer.
    expect(() =>
      workers[0].reply({ type: "result", requestId, ok: true, stl: new ArrayBuffer(4), ms: 10, stdout: "", wasmHeapBytes: 100 })
    ).not.toThrow();
    expect(client.getStatus().kind).toBe("ok");

    client.render("cube(3);", {});
    expect(() => client.dispose()).not.toThrow(); // clears both debounce + timeout timers
  });

  it("the render timeout path fires through the default globals", () => {
    const { client, workers } = makeBrandedClient();
    client.render("cube(1);", {});
    runScheduled(); // debounce -> startRender, which schedules the timeout
    expect(client.getStatus().kind).toBe("pending");

    expect(() => runScheduled()).not.toThrow(); // timeout callback
    expect(client.getStatus().kind).toBe("timeout");
    expect(workers[0].terminated).toBe(true);
  });
});
