import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/apiClient.js";
import { useLiveModelSource } from "./useLiveModelSource.js";

function makeClient(getProject: ApiClient["getProject"]): ApiClient {
  return { getProject } as unknown as ApiClient;
}

describe("useLiveModelSource", () => {
  it("clears prior source and ignores a late reply after project switch", async () => {
    let resolveFirst!: (value: unknown) => void;
    const getProject = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ scad: "cube(2);", params: { size: 2 } });
    const client = makeClient(getProject as ApiClient["getProject"]);
    const { result, rerender } = renderHook(({ projectId }) => useLiveModelSource(client, projectId, "head"), {
      initialProps: { projectId: "p1" }
    });
    expect(result.current.scad).toBeNull();
    rerender({ projectId: "p2" });
    expect(result.current.scad).toBeNull();
    await waitFor(() => expect(result.current.projectId).toBe("p2"));
    expect(result.current.scad).toBe("cube(2);");

    act(() => resolveFirst({ scad: "cube(1);", params: { size: 1 } }));
    await Promise.resolve();
    expect(result.current.projectId).toBe("p2");
    expect(result.current.scad).toBe("cube(2);");
  });
});
