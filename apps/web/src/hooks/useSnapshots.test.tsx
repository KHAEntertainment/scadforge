// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotManifest } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";
import { useSnapshots } from "./useSnapshots.js";

function snapshot(id: string): SnapshotManifest {
  return {
    id,
    parent: null,
    timestamp: "2026-09-13T00:00:00.000Z",
    message: "Snapshot",
    origin: "initial",
    pass: null,
    files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
    params: {},
    renders: [],
    validation: null,
    annotations: []
  };
}

function makeClient(listSnapshots: ApiClient["listSnapshots"]): ApiClient {
  return { listSnapshots } as unknown as ApiClient;
}

describe("useSnapshots — project-switch staleness (Issue #79)", () => {
  it("clears the previous project's snapshots synchronously on the SAME render as a projectId change, before the new fetch resolves", async () => {
    const deferredByProject = new Map<string, (value: { snapshots: SnapshotManifest[] }) => void>();
    const listSnapshots = vi.fn((projectId: string) => {
      if (projectId === "a") return Promise.resolve({ snapshots: [snapshot("a-0001")] });
      return new Promise<{ snapshots: SnapshotManifest[] }>((resolve) => {
        deferredByProject.set(projectId, resolve);
      });
    });
    const client = makeClient(listSnapshots);

    const { result, rerender } = renderHook(({ projectId }) => useSnapshots(client, projectId), {
      initialProps: { projectId: "a" as string | null }
    });

    await waitFor(() => expect(result.current.snapshots).toEqual([snapshot("a-0001")]));

    // Switch to "b", whose fetch we control and have not resolved yet.
    rerender({ projectId: "b" });

    // The stale "a" snapshot must be gone immediately — synchronously, not
    // after "b"'s fetch settles (this is the render-time reset under test;
    // no `waitFor` here is deliberate).
    expect(result.current.snapshots).toEqual([]);

    deferredByProject.get("b")?.({ snapshots: [snapshot("b-0001")] });
    await waitFor(() => expect(result.current.snapshots).toEqual([snapshot("b-0001")]));
  });

  it("rapid A → B → A ends up with A's data, never B's (out-of-order replies ignored)", async () => {
    const deferredByProject = new Map<string, (value: { snapshots: SnapshotManifest[] }) => void>();
    const listSnapshots = vi.fn((projectId: string) => {
      return new Promise<{ snapshots: SnapshotManifest[] }>((resolve) => {
        deferredByProject.set(projectId, resolve);
      });
    });
    const client = makeClient(listSnapshots);

    const { result, rerender } = renderHook(({ projectId }) => useSnapshots(client, projectId), {
      initialProps: { projectId: "a" as string | null }
    });

    rerender({ projectId: "b" });
    rerender({ projectId: "a" });

    // Resolve out of order: B's (now-stale) request answers AFTER the second A request was issued.
    deferredByProject.get("b")?.({ snapshots: [snapshot("b-0001")] });
    deferredByProject.get("a")?.({ snapshots: [snapshot("a-0002")] });

    await waitFor(() => expect(result.current.snapshots).toEqual([snapshot("a-0002")]));
    expect(result.current.snapshots).not.toEqual([snapshot("b-0001")]);
  });

  it("switching to a project with zero snapshots leaves the array empty, not the previous project's data", async () => {
    const listSnapshots = vi.fn((projectId: string) => {
      if (projectId === "a") return Promise.resolve({ snapshots: [snapshot("a-0001")] });
      return Promise.resolve({ snapshots: [] });
    });
    const client = makeClient(listSnapshots);

    const { result, rerender } = renderHook(({ projectId }) => useSnapshots(client, projectId), {
      initialProps: { projectId: "a" as string | null }
    });
    await waitFor(() => expect(result.current.snapshots).toHaveLength(1));

    rerender({ projectId: "fresh" });
    expect(result.current.snapshots).toEqual([]);
    await waitFor(() => expect(listSnapshots).toHaveBeenCalledWith("fresh"));
    expect(result.current.snapshots).toEqual([]);
  });
});
