// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SnapshotManifest } from "@scadforge/protocol";
import { SnapshotList } from "./SnapshotList.js";

function makeSnapshot(overrides: Partial<SnapshotManifest>): SnapshotManifest {
  return {
    id: "0001",
    parent: null,
    timestamp: "2026-08-26T00:00:00.000Z",
    message: "Initial snapshot",
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

describe("SnapshotList", () => {
  it("shows loading state", () => {
    render(<SnapshotList snapshots={[]} loading error={null} />);
    expect(screen.getByText(/loading snapshots/i)).toBeInTheDocument();
  });

  it("counterexample: renders an empty-state message for an empty snapshot list, not a blank list", () => {
    render(<SnapshotList snapshots={[]} loading={false} error={null} />);
    expect(screen.getByTestId("snapshot-list-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("snapshot-list")).not.toBeInTheDocument();
  });

  it("surfaces a fetch error instead of silently showing nothing", () => {
    render(<SnapshotList snapshots={[]} loading={false} error="network down" />);
    expect(screen.getByRole("alert")).toHaveTextContent("network down");
  });

  it("renders one row per snapshot with its validation badge", () => {
    const snapshots = [
      makeSnapshot({ id: "0002", origin: "agent", message: "Widened", validation: { badge: "green", manifold: true, components: 1, volume_mm3: 120, warning_count: 0 } }),
      makeSnapshot({ id: "0001", origin: "initial", message: "Initial", validation: null })
    ];
    render(<SnapshotList snapshots={snapshots} loading={false} error={null} />);
    const rows = screen.getAllByTestId("snapshot-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("#0002")).toBeInTheDocument();
    const badges = screen.getAllByTestId("snapshot-badge");
    expect(badges[0]).toHaveTextContent("Valid");
    expect(badges[1]).toHaveTextContent("Not validated");
  });
});
