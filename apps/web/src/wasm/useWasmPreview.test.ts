import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WasmPreviewClient } from "./wasmPreviewClient.js";
import { useWasmPreviewWithClient } from "./useWasmPreview.js";
import type { WasmWorkerMessage } from "./protocol.js";

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
  reply(msg: WasmWorkerMessage) {
    this.onmessage?.({ data: msg } as MessageEvent<WasmWorkerMessage>);
  }
}

describe("useWasmPreviewWithClient", () => {
  let workers: FakeWorker[];
  let createdUrls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    createdUrls = [];
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => {
        const url = `blob:fake-${createdUrls.length}`;
        createdUrls.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn()
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeClient() {
    return new WasmPreviewClient({
      debounceMs: 50,
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w as unknown as Worker;
      }
    });
  }

  it("counterexample: enabled=false never renders, objectUrl stays null", () => {
    const client = makeClient();
    const { result, unmount } = renderHook(() => useWasmPreviewWithClient(client, "cube(1);", {}, false));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.objectUrl).toBeNull();
    expect(workers).toHaveLength(0);
    // Unmount explicitly (inside the test, while our URL stub is still
    // active) rather than relying on afterEach ordering across files —
    // Vitest runs THIS describe block's afterEach (which unstubs URL)
    // before the global setup.ts afterEach that calls RTL's cleanup().
    act(() => unmount());
  });

  it("produces an object URL from a successful render and tracks status", () => {
    const client = makeClient();
    const { result, unmount } = renderHook(() => useWasmPreviewWithClient(client, "cube(1);", {}, true));

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(workers).toHaveLength(1);
    const requestId = (workers[0].posted[0] as { requestId: string }).requestId;

    act(() => {
      workers[0].reply({ type: "result", requestId, ok: true, stl: new ArrayBuffer(4), ms: 12, stdout: "", wasmHeapBytes: 100 });
    });

    expect(result.current.status).toBe("ok");
    expect(result.current.objectUrl).toBe("blob:fake-0");
    expect(result.current.lastRenderMs).toBe(12);
    act(() => unmount());
  });

  it("surfaces stderr on a failed render without touching objectUrl", () => {
    const client = makeClient();
    const { result, unmount } = renderHook(() => useWasmPreviewWithClient(client, "bad(", {}, true));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const requestId = (workers[0].posted[0] as { requestId: string }).requestId;

    act(() => {
      workers[0].reply({ type: "result", requestId, ok: false, stderr: "ERROR: bad syntax", ms: 3 });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.stderr).toBe("ERROR: bad syntax");
    expect(result.current.objectUrl).toBeNull();
    act(() => unmount());
  });
});
