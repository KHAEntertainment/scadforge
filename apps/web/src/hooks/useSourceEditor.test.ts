import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/apiClient.js";
import { useSourceEditor } from "./useSourceEditor.js";

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "",
    getSource: vi.fn(),
    preflightSource: vi.fn(),
    updateSource: vi.fn(),
    ...overrides
  } as unknown as ApiClient;
}

afterEach(() => sessionStorage.clear());

describe("useSourceEditor", () => {
  it("restores the original draft revision and surfaces drift instead of rebasing", async () => {
    sessionStorage.setItem("scadforge:source-draft:p1", JSON.stringify({ draftScad: "cube(4);", savedScad: "cube(1);", baseRevision: "r1" }));
    const api = client({ getSource: vi.fn().mockResolvedValue({ scad: "cube(2);", params: {}, revision: "r2", project: {} }) });
    const { result } = renderHook(() => useSourceEditor(api, "p1"));
    await waitFor(() => expect(result.current.dirty).toBe(true));
    expect(result.current.draftScad).toBe("cube(4);");
    expect(result.current.baseRevision).toBe("r1");
    expect(result.current.conflict).toBe(true);
  });

  it("keeps newer typing when a save response for older text arrives", async () => {
    let resolveUpdate!: (value: unknown) => void;
    const updateSource = vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; }));
    const api = client({
      getSource: vi.fn().mockResolvedValue({ scad: "cube(1);", params: {}, revision: "r1", project: {} }),
      preflightSource: vi.fn().mockResolvedValue({ revision: "r1", syntax_ok: true, diagnostics: null, parameters: [], retained_params: {}, removed_params: [] }),
      updateSource: updateSource as unknown as ApiClient["updateSource"]
    });
    const { result } = renderHook(() => useSourceEditor(api, "p1"));
    await waitFor(() => expect(result.current.baseRevision).toBe("r1"));
    act(() => result.current.setDraft("cube(2);"));
    act(() => result.current.save());
    await waitFor(() => expect(updateSource).toHaveBeenCalled());
    act(() => result.current.setDraft("cube(3);"));
    act(() => resolveUpdate({ scad: "cube(2);", params: {}, revision: "r2", project: {} }));
    await waitFor(() => expect(result.current.baseRevision).toBe("r2"));
    expect(result.current.draftScad).toBe("cube(3);");
    expect(result.current.dirty).toBe(true);
  });

  it("requires explicit acknowledgement for incompatible overrides", async () => {
    const updateSource = vi.fn().mockResolvedValue({ scad: "cube(size);", params: {}, revision: "r2", project: {} });
    const api = client({
      getSource: vi.fn().mockResolvedValue({ scad: "cube(size);", params: { size: 2 }, revision: "r1", project: {} }),
      preflightSource: vi.fn().mockResolvedValue({ revision: "r1", syntax_ok: true, diagnostics: null, parameters: [], retained_params: {}, removed_params: [{ name: "size", reason: "value out of range" }] }),
      updateSource
    });
    const { result } = renderHook(() => useSourceEditor(api, "p1"));
    await waitFor(() => expect(result.current.baseRevision).toBe("r1"));
    act(() => result.current.setDraft("cube(1);"));
    act(() => result.current.save());
    await waitFor(() => expect(result.current.pendingRemoved).toHaveLength(1));
    expect(updateSource).not.toHaveBeenCalled();
    act(() => result.current.acknowledgeSave());
    await waitFor(() => expect(updateSource).toHaveBeenCalledWith("p1", expect.objectContaining({ discarded_params: ["size"] })));
  });
});
