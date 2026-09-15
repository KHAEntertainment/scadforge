// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotManifest } from "@scadforge/protocol";
import { ApiClientError, type ApiClient } from "../../lib/apiClient.js";
import { RevertButton } from "./RevertButton.js";

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
    id: "0003",
    parent: "0002",
    timestamp: "2026-08-27T00:00:00.000Z",
    message: "Revert to 0001",
    origin: "revert",
    pass: null,
    files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: "diff.patch" },
    params: {},
    renders: [],
    validation: null,
    annotations: [],
    ...overrides
  };
}

describe("RevertButton", () => {
  it("is disabled and labeled distinctly when the selected snapshot is already the head", () => {
    render(
      <RevertButton client={makeClient({})} projectId="p1" snapshotId="0001" isHead onReverted={vi.fn()} />
    );
    const button = screen.getByTestId("revert-trigger");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/current head/i);
  });

  it("requires a confirm step before calling the API", async () => {
    const revertSnapshot = vi.fn().mockResolvedValue({ snapshot: makeSnapshot({}), scad: "" });
    render(
      <RevertButton client={makeClient({ revertSnapshot })} projectId="p1" snapshotId="0001" isHead={false} onReverted={vi.fn()} />
    );
    await userEvent.click(screen.getByTestId("revert-trigger"));
    expect(revertSnapshot).not.toHaveBeenCalled();
    expect(screen.getByTestId("revert-confirm")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("revert-confirm-yes"));
    await waitFor(() => expect(revertSnapshot).toHaveBeenCalledWith("p1", "0001", {}));
  });

  it("calls onReverted with the new snapshot on success (append-only: a NEW snapshot, never the reverted-from one)", async () => {
    const newSnapshot = makeSnapshot({ id: "0004" });
    const revertSnapshot = vi.fn().mockResolvedValue({ snapshot: newSnapshot, scad: "" });
    const onReverted = vi.fn();
    render(
      <RevertButton client={makeClient({ revertSnapshot })} projectId="p1" snapshotId="0001" isHead={false} onReverted={onReverted} />
    );
    await userEvent.click(screen.getByTestId("revert-trigger"));
    await userEvent.click(screen.getByTestId("revert-confirm-yes"));

    await waitFor(() => expect(screen.getByTestId("revert-success")).toBeInTheDocument());
    expect(onReverted).toHaveBeenCalledWith(newSnapshot);
    expect(newSnapshot.id).not.toBe("0001");
  });

  it("counterexample: a CONFLICT (409) from concurrent writes is surfaced distinctly, with a retry — never a silent overwrite", async () => {
    const revertSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError({ error_code: "CONFLICT", message: "could not allocate a snapshot id" }))
      .mockResolvedValueOnce({ snapshot: makeSnapshot({}), scad: "" });
    const onReverted = vi.fn();
    render(
      <RevertButton client={makeClient({ revertSnapshot })} projectId="p1" snapshotId="0001" isHead={false} onReverted={onReverted} />
    );
    await userEvent.click(screen.getByTestId("revert-trigger"));
    await userEvent.click(screen.getByTestId("revert-confirm-yes"));

    await waitFor(() => expect(screen.getByTestId("revert-conflict")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/refresh.*try again/i);
    expect(onReverted).not.toHaveBeenCalled();

    // Retry succeeds once the contention clears.
    await userEvent.click(screen.getByTestId("revert-retry"));
    await waitFor(() => expect(onReverted).toHaveBeenCalled());
    expect(revertSnapshot).toHaveBeenCalledTimes(2);
  });

  it("counterexample: a non-conflict failure shows a generic message, distinct from the conflict path", async () => {
    const revertSnapshot = vi.fn().mockRejectedValue(new ApiClientError({ error_code: "SNAPSHOT_NOT_FOUND", message: "no such snapshot" }));
    render(
      <RevertButton client={makeClient({ revertSnapshot })} projectId="p1" snapshotId="0099" isHead={false} onReverted={vi.fn()} />
    );
    await userEvent.click(screen.getByTestId("revert-trigger"));
    await userEvent.click(screen.getByTestId("revert-confirm-yes"));

    await waitFor(() => expect(screen.getByTestId("revert-failed")).toBeInTheDocument());
    expect(screen.queryByTestId("revert-conflict")).not.toBeInTheDocument();
    expect(screen.getByTestId("revert-failed")).toHaveTextContent("no such snapshot");
  });
});
