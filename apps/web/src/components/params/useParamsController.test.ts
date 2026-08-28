import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamsResponse } from "@scadforge/protocol";
import { ApiClientError, type ApiClient } from "../../lib/apiClient.js";
import { PARAMS_DEBOUNCE_MS, useParamsController } from "./useParamsController.js";

function makeClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    baseUrl: "",
    health: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listSnapshots: vi.fn(),
    openChatStream: vi.fn(),
    exportModel: vi.fn(),
    fetchExportFile: vi.fn(),
    resolveUrl: vi.fn((path: string) => path),
    getParams: vi.fn(),
    updateParams: vi.fn(),
    ...overrides
  } as ApiClient;
}

/** Drains the microtask queue several times over — a `.then().catch().finally()` chain settles across more than one tick. */
async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function schema(values: Record<string, number> = { wall: 4 }): ParamsResponse {
  return {
    title: "bracket",
    parameters: Object.keys(values).map((name) => ({ name, type: "number", initial: values[name], min: 0, max: 10 })),
    values
  };
}

describe("useParamsController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counterexample: empty schema loads to an empty parameter list, not a broken/errored state", async () => {
    const getParams = vi.fn().mockResolvedValue({ title: "empty", parameters: [], values: {} });
    const client = makeClient({ getParams });

    const { result } = renderHook(() => useParamsController(client, "p1", null));
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loadError).toBeNull();
    expect(result.current.parameters).toEqual([]);
  });

  it("rapid successive writes: coalesces bursts into one PUT with the latest value, no lost/stale update", async () => {
    const updateParams = vi.fn().mockResolvedValue(schema({ wall: 9 }));
    const client = makeClient({ getParams: vi.fn().mockResolvedValue(schema({ wall: 4 })), updateParams });

    const { result } = renderHook(() => useParamsController(client, "p1", null));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.setValue("wall", 5);
      result.current.setValue("wall", 7);
      result.current.setValue("wall", 9); // last value before the debounce window closes
    });
    expect(result.current.values.wall).toBe(9); // UI is responsive immediately

    await act(async () => {
      vi.advanceTimersByTime(PARAMS_DEBOUNCE_MS);
      await flushMicrotasks();
    });

    expect(updateParams).toHaveBeenCalledTimes(1);
    expect(updateParams).toHaveBeenCalledWith("p1", { values: { wall: 9 } });
  });

  it("a second edit that lands WHILE a PUT is in flight is queued, not dropped or sent as an overlapping request", async () => {
    let resolveFirst!: (value: ParamsResponse) => void;
    const updateParams = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ParamsResponse>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(schema({ wall: 8 }));
    const client = makeClient({ getParams: vi.fn().mockResolvedValue(schema({ wall: 4 })), updateParams });

    const { result } = renderHook(() => useParamsController(client, "p1", null));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.setValue("wall", 6);
    });
    await act(async () => {
      vi.advanceTimersByTime(PARAMS_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(updateParams).toHaveBeenCalledTimes(1); // first PUT now in flight

    act(() => {
      result.current.setValue("wall", 8); // edited again mid-flight
    });
    await act(async () => {
      vi.advanceTimersByTime(PARAMS_DEBOUNCE_MS);
      await Promise.resolve();
    });
    // Still only one PUT in flight — never two overlapping requests (#44).
    expect(updateParams).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(schema({ wall: 6 }));
      await flushMicrotasks();
    });
    // The queued edit is sent the instant the first request settles.
    expect(updateParams).toHaveBeenCalledTimes(2);
    expect(updateParams).toHaveBeenLastCalledWith("p1", { values: { wall: 8 } });
  });

  it("counterexample: server rejects a value — the control reverts to the last known-good value and surfaces the error", async () => {
    const updateParams = vi.fn().mockRejectedValue(new ApiClientError({ error_code: "VALIDATION_FAILED", message: "'wall' value 99 is above its max of 10." }));
    const client = makeClient({ getParams: vi.fn().mockResolvedValue(schema({ wall: 4 })), updateParams });

    const { result } = renderHook(() => useParamsController(client, "p1", null));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.setValue("wall", 99);
    });
    await act(async () => {
      vi.advanceTimersByTime(PARAMS_DEBOUNCE_MS);
      await flushMicrotasks();
    });

    expect(result.current.values.wall).toBe(4); // reverted
    expect(result.current.saveError).toMatch(/above its max/);
    expect(result.current.dirty.has("wall")).toBe(false);
  });

  it("agent/UI conflict policy: an SSE-driven snapshot (new headSnapshotId) updates a param the user has NOT touched, but does not clobber one they are mid-edit on", async () => {
    const getParams = vi
      .fn()
      .mockResolvedValueOnce(schema({ wall: 4, length: 10 }))
      // Reconciliation after a `snapshot_created` event carrying an agent-driven update to BOTH params.
      .mockResolvedValueOnce(schema({ wall: 40, length: 100 }));
    const updateParams = vi.fn().mockResolvedValue(schema({ wall: 4, length: 10 }));
    const client = makeClient({ getParams, updateParams });

    const { result, rerender } = renderHook(({ headSnapshotId }) => useParamsController(client, "p1", headSnapshotId), {
      initialProps: { headSnapshotId: null as string | null }
    });
    await act(async () => {
      await Promise.resolve();
    });

    // User starts editing `length` locally but the debounce hasn't fired yet
    // (still "dirty", nothing sent to the server).
    act(() => {
      result.current.setValue("length", 55);
    });
    expect(result.current.dirty.has("length")).toBe(true);

    // An agent turn lands mid-edit: `snapshot_created` bumps the head snapshot.
    rerender({ headSnapshotId: "0002" });
    await act(async () => {
      await Promise.resolve();
    });

    // `wall` (untouched locally) adopts the server's new value...
    expect(result.current.values.wall).toBe(40);
    // ...but `length` (in-flight local edit) is NOT clobbered by the agent's value.
    expect(result.current.values.length).toBe(55);
  });

  it("a schema that changes shape between snapshots (parameter added/removed) is picked up on reconciliation", async () => {
    const getParams = vi
      .fn()
      .mockResolvedValueOnce(schema({ wall: 4 }))
      .mockResolvedValueOnce({
        title: "bracket",
        parameters: [
          { name: "wall", type: "number", initial: 4, min: 0, max: 10 },
          { name: "height", type: "number", initial: 20, min: 0, max: 50 }
        ],
        values: { wall: 4, height: 20 }
      });
    const client = makeClient({ getParams, updateParams: vi.fn() });

    const { result, rerender } = renderHook(({ headSnapshotId }) => useParamsController(client, "p1", headSnapshotId), {
      initialProps: { headSnapshotId: null as string | null }
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.parameters.map((p) => p.name)).toEqual(["wall"]);

    rerender({ headSnapshotId: "0002" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.parameters.map((p) => p.name)).toEqual(["wall", "height"]);
    expect(result.current.values.height).toBe(20);
  });
});
