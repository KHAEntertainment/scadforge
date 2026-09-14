import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotManifest } from "@scadforge/protocol";
import type { ApiClient } from "../../lib/apiClient.js";
import { SnapshotList } from "./SnapshotList.js";

function makeClient(): ApiClient {
  return {
    baseUrl: "",
    health: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listSnapshots: vi.fn(),
    getSnapshot: vi.fn(),
    getSnapshotDiff: vi.fn(),
    revertSnapshot: vi.fn(),
    openChatStream: vi.fn(),
    exportModel: vi.fn(),
    getParams: vi.fn(),
    updateParams: vi.fn(),
    getSource: vi.fn(),
    preflightSource: vi.fn(),
    updateSource: vi.fn(),
    build: vi.fn(),
    fetchExportFile: vi.fn(),
    resolveUrl: vi.fn((path: string) => `http://api.test${path}`),
    headRaw: vi.fn()
  } as ApiClient;
}

function makeSnapshot(overrides: Partial<SnapshotManifest>): SnapshotManifest {
  return {
    id: "0001",
    parent: null,
    timestamp: "2026-08-26T04:36:49.512Z",
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

describe("SnapshotList (history)", () => {
  it("shows loading state", () => {
    render(<SnapshotList client={makeClient()} snapshots={[]} loading error={null} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/loading snapshots/i)).toBeInTheDocument();
  });

  it("counterexample: renders an empty-state message for an empty snapshot list, not a blank list", () => {
    render(<SnapshotList client={makeClient()} snapshots={[]} loading={false} error={null} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId("snapshot-list-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("snapshot-list")).not.toBeInTheDocument();
  });

  it("surfaces a fetch error instead of silently showing nothing", () => {
    render(<SnapshotList client={makeClient()} snapshots={[]} loading={false} error="network down" selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("network down");
  });

  it("renders one row per snapshot, newest-first order as given, with thumbnail/excerpt/timestamp/badge", () => {
    const snapshots = [
      makeSnapshot({
        id: "0002",
        origin: "agent",
        message: "Widened the bracket significantly to fit the new bolt pattern spec from the customer",
        validation: { badge: "green", manifold: true, components: 1, volume_mm3: 120, warning_count: 0 },
        renders: [{ view: "iso", file: "views/iso.png", url: "/api/projects/p1/snapshots/0002/views/iso", width: 0, height: 0, bytes: 10, render_ms: 5 }]
      }),
      makeSnapshot({ id: "0001", origin: "initial", message: "Initial", validation: null })
    ];
    render(<SnapshotList client={makeClient()} snapshots={snapshots} loading={false} error={null} selectedId="0002" onSelect={vi.fn()} />);

    const rows = screen.getAllByTestId("snapshot-row");
    expect(rows).toHaveLength(2);
    // Order preserved verbatim (the component must not re-sort — the API already returns newest first).
    expect(screen.getByText("#0002")).toBeInTheDocument();

    const badges = screen.getAllByTestId("snapshot-badge");
    expect(badges[0]).toHaveTextContent("Valid");
    expect(badges[1]).toHaveTextContent("Not validated");

    // Long messages are excerpted, not dumped in full.
    const messages = screen.getAllByTestId("snapshot-message");
    expect(messages[0].textContent!.length).toBeLessThan(90);
    expect(messages[0].textContent).toMatch(/…$/);

    // Timestamp rendered deterministically (no locale conversion).
    expect(screen.getAllByTestId("snapshot-timestamp")[0]).toHaveTextContent("2026-08-26 04:36:49");

    // Thumbnail present for the row with an iso render, placeholder for the row without one.
    const img = screen.getByAltText("Snapshot 0002 iso view") as HTMLImageElement;
    expect(img.src).toContain("http://api.test/api/projects/p1/snapshots/0002/views/iso");

    // Selection reflected via aria-pressed.
    expect(rows[0]).toHaveAttribute("aria-pressed", "true");
    expect(rows[1]).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the enriched manifest's validation status (ok / warnings / failed), never falling back to 'Not validated' when validation is set (Issue #78 AC4)", () => {
    // Mirrors `readSnapshotManifest`'s merge (packages/scad-core/src/store/derived.ts):
    // a row's `validation` field IS the source of truth this component reads,
    // regardless of how long ago the snapshot itself was created.
    const snapshots = [
      makeSnapshot({
        id: "0004",
        validation: { badge: "green", manifold: true, components: 1, volume_mm3: 500, warning_count: 0 }
      }),
      makeSnapshot({
        id: "0003",
        validation: { badge: "amber", manifold: true, components: 2, volume_mm3: 500, warning_count: 1 }
      }),
      makeSnapshot({
        id: "0002",
        validation: { badge: "red", manifold: false, components: null, volume_mm3: null, warning_count: 0 }
      }),
      makeSnapshot({ id: "0001", validation: null })
    ];
    render(<SnapshotList client={makeClient()} snapshots={snapshots} loading={false} error={null} selectedId={null} onSelect={vi.fn()} />);

    const badges = screen.getAllByTestId("snapshot-badge");
    expect(badges[0]).toHaveTextContent("Valid");
    expect(badges[1]).toHaveTextContent("Warnings");
    expect(badges[2]).toHaveTextContent("Invalid");
    // A row with no validation attached is the only one that keeps "Not validated".
    expect(badges[3]).toHaveTextContent("Not validated");
  });

  it("calls onSelect with the clicked snapshot's id", async () => {
    const onSelect = vi.fn();
    const snapshots = [makeSnapshot({ id: "0001" }), makeSnapshot({ id: "0002", parent: "0001" })];
    render(<SnapshotList client={makeClient()} snapshots={snapshots} loading={false} error={null} selectedId={null} onSelect={onSelect} />);

    await userEvent.click(screen.getAllByTestId("snapshot-row")[1]);
    expect(onSelect).toHaveBeenCalledWith("0002");
  });
});
