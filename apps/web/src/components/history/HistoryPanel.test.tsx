import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotManifest } from "@scadforge/protocol";
import type { ApiClient } from "../../lib/apiClient.js";
import { HistoryPanel } from "./HistoryPanel.js";

function makeClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    baseUrl: "",
    health: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listSnapshots: vi.fn(),
    getSnapshotDiff: vi.fn(),
    revertSnapshot: vi.fn(),
    openChatStream: vi.fn(),
    exportModel: vi.fn(),
    fetchExportFile: vi.fn(),
    resolveUrl: vi.fn((path: string) => path),
    ...overrides
  } as ApiClient;
}

function makeSnapshot(overrides: Partial<SnapshotManifest>): SnapshotManifest {
  return {
    id: "0001",
    parent: null,
    timestamp: "2026-08-26T00:00:00.000Z",
    message: "Initial",
    origin: "initial",
    pass: null,
    files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
    params: {},
    renders: [],
    validation: null,
    annotations: [],
    ...overrides
  };
}

describe("HistoryPanel", () => {
  it("selects the newest snapshot by default and fetches its diff", async () => {
    const snapshots = [
      makeSnapshot({ id: "0002", parent: "0001", message: "Second" }),
      makeSnapshot({ id: "0001", parent: null, message: "First" })
    ];
    const getSnapshotDiff = vi.fn().mockResolvedValue({ id: "0002", parent: "0001", diff: "+cube([1,1,1]);" });
    render(
      <HistoryPanel client={makeClient({ getSnapshotDiff })} projectId="p1" snapshots={snapshots} loading={false} error={null} onChanged={vi.fn()} />
    );

    await waitFor(() => expect(getSnapshotDiff).toHaveBeenCalledWith("p1", "0002"));
    await waitFor(() => expect(screen.getByTestId("diff-view")).toHaveTextContent("+cube([1,1,1]);"));
  });

  it("re-fetches the diff when a different snapshot row is selected", async () => {
    const snapshots = [
      makeSnapshot({ id: "0002", parent: "0001", message: "Second" }),
      makeSnapshot({ id: "0001", parent: null, message: "First" })
    ];
    const getSnapshotDiff = vi.fn().mockImplementation((_projectId: string, snapshotId: string) => {
      if (snapshotId === "0001") return Promise.resolve({ id: "0001", parent: null, diff: "" });
      return Promise.resolve({ id: "0002", parent: "0001", diff: "+cube([1,1,1]);" });
    });
    render(
      <HistoryPanel client={makeClient({ getSnapshotDiff })} projectId="p1" snapshots={snapshots} loading={false} error={null} onChanged={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByTestId("diff-view")).toBeInTheDocument());

    await userEvent.click(screen.getAllByTestId("snapshot-row")[1]); // select #0001 (the first snapshot)
    await waitFor(() => expect(screen.getByTestId("diff-first-snapshot")).toBeInTheDocument());
  });

  it("counterexample: reverting selects the newly-created snapshot and notifies the parent to refresh (append-only — the list grows, nothing is removed)", async () => {
    // Two snapshots so the target (0001) is NOT the current head (0002) —
    // reverting to the head itself is a disabled no-op (see the empty-list test below).
    const snapshots = [
      makeSnapshot({ id: "0002", parent: "0001", message: "Second" }),
      makeSnapshot({ id: "0001", parent: null, message: "First" })
    ];
    const reverted = makeSnapshot({ id: "0003", parent: "0002", origin: "revert", message: "Revert to 0001" });
    const getSnapshotDiff = vi.fn().mockResolvedValue({ id: "0001", parent: null, diff: "" });
    const revertSnapshot = vi.fn().mockResolvedValue({ snapshot: reverted, scad: "" });
    const onChanged = vi.fn();

    render(
      <HistoryPanel
        client={makeClient({ getSnapshotDiff, revertSnapshot })}
        projectId="p1"
        snapshots={snapshots}
        loading={false}
        error={null}
        onChanged={onChanged}
      />
    );
    // Select the older, non-head snapshot (#0001).
    await waitFor(() => expect(screen.getAllByTestId("snapshot-row")).toHaveLength(2));
    await userEvent.click(screen.getAllByTestId("snapshot-row")[1]);
    await waitFor(() => expect(screen.getByTestId("diff-first-snapshot")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("revert-trigger"));
    await userEvent.click(screen.getByTestId("revert-confirm-yes"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(revertSnapshot).toHaveBeenCalledWith("p1", "0001", {});
  });

  it("counterexample: an empty snapshot list shows the list's empty state and no diff/revert affordance for a nonexistent selection", () => {
    render(<HistoryPanel client={makeClient({})} projectId="p1" snapshots={[]} loading={false} error={null} onChanged={vi.fn()} />);
    expect(screen.getByTestId("snapshot-list-empty")).toBeInTheDocument();
    expect(screen.getByTestId("diff-empty-selection")).toBeInTheDocument();
    expect(screen.getByTestId("revert-trigger")).toBeDisabled();
  });
});
