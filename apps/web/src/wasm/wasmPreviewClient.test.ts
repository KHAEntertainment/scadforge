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
