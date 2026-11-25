// SPDX-License-Identifier: Apache-2.0

// Issue #143 — the snapshot mesh probe and its explicit re-probe trigger:
// probes counted per call, no probe when nothing happened, `checking` only on
// an identity change (a re-probe of the same snapshot keeps its result until
// the answer arrives), and the PR #140 identity rule's out-of-order guard.

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../lib/apiClient.js";
import { useSnapshotMesh } from "./useSnapshotMesh.js";

interface Probe {
  path: string;
  resolve: (ok: boolean) => void;
  reject: (cause?: unknown) => void;
}

/** A client whose `headRaw` probes settle only when the test says so. */
function makeClient(): { client: ApiClient; probes: Probe[] } {
  const probes: Probe[] = [];
  const client = {
    resolveUrl: (path: string) => path,
    headRaw: (path: string) =>
      new Promise<boolean>((resolve, reject) => {
        probes.push({ path, resolve, reject });
      })
  } as unknown as ApiClient;
  return { client, probes };
}

const MESH_PATH = "/api/projects/p1/snapshots/0001/mesh";

describe("useSnapshotMesh — probes and the re-probe trigger (Issue #143)", () => {
  it("probes once per selection and reports the identity the result was requested for", async () => {
    const { client, probes } = makeClient();
    const { result } = renderHook(() => useSnapshotMesh(client, "p1", "0001"));

    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0].path).toBe(MESH_PATH);
    expect(result.current).toMatchObject({ url: null, status: "checking", projectId: "p1", snapshotId: "0001" });

    probes[0].resolve(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.url).toBe(MESH_PATH);
    expect(result.current.projectId).toBe("p1");
    expect(result.current.snapshotId).toBe("0001");
    expect(result.current.reprobe).toBeTypeOf("function");
    expect(probes).toHaveLength(1);
  });

  it("a re-probe for the same snapshot keeps a ready result until the answer arrives", async () => {
    const { client, probes } = makeClient();
    const { result } = renderHook(() => useSnapshotMesh(client, "p1", "0001"));
    await waitFor(() => expect(probes).toHaveLength(1));
    probes[0].resolve(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.reprobe!());
    await waitFor(() => expect(probes).toHaveLength(2));
    // The answer is still out: the ready result stays — no `checking`, the url
    // is never null in between (a Build on a built head must not flash).
    expect(result.current.status).toBe("ready");
    expect(result.current.url).toBe(MESH_PATH);
    expect(result.current.snapshotId).toBe("0001");

    probes[1].resolve(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.url).toBe(MESH_PATH);
    expect(probes).toHaveLength(2);
  });

  it("a re-probe for the same snapshot keeps absent until the answer arrives, then becomes ready", async () => {
    const { client, probes } = makeClient();
    const { result } = renderHook(() => useSnapshotMesh(client, "p1", "0001"));
    await waitFor(() => expect(probes).toHaveLength(1));
    probes[0].resolve(false);
    await waitFor(() => expect(result.current.status).toBe("absent"));

    // The #143 sequence: Build attached a mesh to the snapshot already current.
    act(() => result.current.reprobe!());
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(result.current.status).toBe("absent"); // not "checking"
    expect(result.current.snapshotId).toBe("0001");

    probes[1].resolve(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.url).toBe(MESH_PATH);
    expect(probes).toHaveLength(2);
  });

  it("issues no probe on re-render alone, and none after a re-probe settles", async () => {
    const { client, probes } = makeClient();
    const { result, rerender } = renderHook(() => useSnapshotMesh(client, "p1", "0001"));
    await waitFor(() => expect(probes).toHaveLength(1));
    probes[0].resolve(false);
    await waitFor(() => expect(result.current.status).toBe("absent"));

    rerender();
    rerender();
    expect(probes).toHaveLength(1);

    act(() => result.current.reprobe!());
    await waitFor(() => expect(probes).toHaveLength(2));
    probes[1].resolve(false);
    await waitFor(() => expect(result.current.status).toBe("absent"));
    rerender();
    expect(probes).toHaveLength(2); // no loop, no polling
  });

  it("one probe when the selection and reprobe() change together, showing checking for the new id", async () => {
    const { client, probes } = makeClient();
    const { result, rerender } = renderHook(({ snapshotId }) => useSnapshotMesh(client, "p1", snapshotId), {
      initialProps: { snapshotId: "0001" }
    });
    await waitFor(() => expect(probes).toHaveLength(1));
    probes[0].resolve(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // A Build whose result is a different snapshot: both inputs change in one
    // render — exactly one probe, and a new identity publishes `checking`.
    act(() => {
      result.current.reprobe!();
      rerender({ snapshotId: "0002" });
    });
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].path).toBe("/api/projects/p1/snapshots/0002/mesh");
    expect(result.current).toMatchObject({ url: null, status: "checking", projectId: "p1", snapshotId: "0002" });

    probes[1].resolve(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.url).toBe("/api/projects/p1/snapshots/0002/mesh");
    expect(probes).toHaveLength(2);
  });

  it("a reply that lands after the selection changed is dropped", async () => {
    const { client, probes } = makeClient();
    const { result, rerender } = renderHook(({ snapshotId }) => useSnapshotMesh(client, "p1", snapshotId), {
      initialProps: { snapshotId: "0001" }
    });
    await waitFor(() => expect(probes).toHaveLength(1));
    rerender({ snapshotId: "0002" });
    await waitFor(() => expect(probes).toHaveLength(2));

    // The old probe answers late: it must never overwrite the new selection's
    // result (PR #140's identity rule).
    await act(async () => {
      probes[0].resolve(true);
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ url: null, status: "checking", snapshotId: "0002" });

    probes[1].resolve(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.snapshotId).toBe("0002");
    expect(result.current.url).toBe("/api/projects/p1/snapshots/0002/mesh");
  });

  it("a probe that rejects ends in absent, with its identity", async () => {
    const { client, probes } = makeClient();
    const { result } = renderHook(() => useSnapshotMesh(client, "p1", "0001"));
    await waitFor(() => expect(probes).toHaveLength(1));

    probes[0].reject(new Error("network down"));
    await waitFor(() => expect(result.current.status).toBe("absent"));
    expect(result.current.url).toBeNull();
    expect(result.current.projectId).toBe("p1");
    expect(result.current.snapshotId).toBe("0001");
    expect(probes).toHaveLength(1);
  });
});
