import { useEffect, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotManifest } from "@scadforge/protocol";
import { App } from "./App.js";

const harness = vi.hoisted(() => ({
  project: {
    project: { id: "p1" },
    loading: false,
    error: null
  },
  chat: {
    state: {
      headSnapshot: null as SnapshotManifest | null,
      items: [],
      activeTurnId: null as string | null
    },
    isStreaming: false,
    streamError: null,
    sendMessage: vi.fn()
  },
  snapshots: [] as SnapshotManifest[],
  snapshotsLoading: false,
  refresh: vi.fn(),
  liveSource: { scad: "cube(1);", params: {} as Record<string, unknown> },
  controller: {
    loading: false,
    loadError: null,
    title: "p1",
    parameters: [],
    values: {} as Record<string, unknown>,
    debouncedValues: {} as Record<string, unknown>,
    dirty: new Set<string>(),
    saving: false,
    saveError: null,
    initialized: true,
    setValue: vi.fn()
  },
  liveHead: null as string | null,
  controllerHead: null as string | null,
  controllerOnSaved: null as (() => void) | null,
  previewMountCount: 0,
  historyMountCount: 0
}));

vi.mock("./hooks/useProject.js", () => ({
  useProject: () => harness.project
}));

vi.mock("./hooks/useChat.js", () => ({
  useChat: () => harness.chat
}));

vi.mock("./hooks/useSnapshots.js", () => ({
  useSnapshots: () => ({
    snapshots: harness.snapshots,
    loading: harness.snapshotsLoading,
    error: null,
    refresh: harness.refresh
  })
}));

vi.mock("./hooks/useLiveModelSource.js", () => ({
  useLiveModelSource: (_client: unknown, _projectId: string | null, headSnapshotId: string | null) => {
    harness.liveHead = headSnapshotId;
    return harness.liveSource;
  }
}));

vi.mock("./components/params/useParamsController.js", () => ({
  useParamsController: (
    _client: unknown,
    _projectId: string | null,
    headSnapshotId: string | null,
    onSaved?: () => void
  ) => {
    harness.controllerHead = headSnapshotId;
    harness.controllerOnSaved = onSaved ?? null;
    return harness.controller;
  }
}));

vi.mock("./hooks/useSnapshotMesh.js", () => ({
  useSnapshotMesh: (_client: unknown, _projectId: string | null, snapshotId: string | null) => ({
    url: snapshotId ? `/mesh/${snapshotId}` : null,
    status: snapshotId === "0003" ? "missing" : "ready",
    error: null
  })
}));

vi.mock("./components/StatusStrip.js", () => ({ StatusStrip: () => null }));
vi.mock("./components/ChatPanel.js", () => ({ ChatPanel: () => null }));
vi.mock("./components/ParamsTab.js", () => ({ ParamsTab: () => null }));
vi.mock("./components/params/ParamsTab.js", () => ({ ParamsTab: () => null }));
vi.mock("./components/Workspace.js", () => ({
  Workspace: ({ preview, params, history }: { preview: ReactNode; params: ReactNode; history: ReactNode }) => (
    <>
      {preview}
      {params}
      {history}
    </>
  )
}));
vi.mock("./components/PreviewTab.js", () => ({
  PreviewTab: (props: {
    snapshotId?: string | null;
    validation?: { volume_mm3: number | null } | null;
    liveParams: Record<string, unknown>;
    meshStatus: string;
  }) => {
    // Mount-count tracking (Issue #79): `App.tsx` keys this element by
    // `projectId` so a project switch remounts it, clearing its internal
    // measure/measureAxis/inspectOutcome state. A plain ordinary re-render
    // (e.g. selecting a different snapshot within the SAME project) must
    // NOT remount it — that would be its own regression (losing the user's
    // Grid/Measure toggles on every History click).
    useEffect(() => {
      harness.previewMountCount += 1;
    }, []);
    return (
      <output
        data-testid="preview-state"
        data-snapshot={props.snapshotId ?? "none"}
        data-validation={props.validation?.volume_mm3 ?? "none"}
        data-params={JSON.stringify(props.liveParams)}
        data-mesh-status={props.meshStatus}
      />
    );
  }
}));
vi.mock("./components/HistoryTab.js", () => ({
  HistoryTab: (props: { onSelectSnapshot?: (id: string) => void; onExported: () => void }) => {
    useEffect(() => {
      harness.historyMountCount += 1;
    }, []);
    return (
      <div>
        <button type="button" onClick={() => props.onSelectSnapshot?.("0001")}>
          Select 0001
        </button>
        <button type="button" onClick={props.onExported}>
          Refresh history
        </button>
      </div>
    );
  }
}));

function snapshot(id: string, overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    id,
    parent: id === "0001" ? null : "0001",
    timestamp: `2026-09-08T00:00:0${id}.000Z`,
    message: `Snapshot ${id}`,
    origin: "manual",
    pass: null,
    files: {
      model_scad: "model.scad",
      params_json: "params.json",
      message_md: "message.md",
      validation_json: null,
      diff_patch: id === "0001" ? null : "diff.patch"
    },
    params: {},
    renders: [],
    validation: null,
    annotations: [],
    ...overrides
  };
}

beforeEach(() => {
  harness.project = { project: { id: "p1" }, loading: false, error: null };
  harness.chat.state = { headSnapshot: null, items: [], activeTurnId: null };
  harness.chat.isStreaming = false;
  harness.snapshots = [];
  harness.refresh.mockReset();
  harness.liveSource = { scad: "cube(1);", params: {} };
  harness.controller.debouncedValues = {};
  harness.controller.values = {};
  harness.controller.initialized = true;
  harness.liveHead = null;
  harness.controllerHead = null;
  harness.controllerOnSaved = null;
  harness.previewMountCount = 0;
  harness.historyMountCount = 0;
});

describe("App working-head synchronization", () => {
  it("drives source/controller and default preview from the newest persisted snapshot when chat has no head", () => {
    harness.snapshots = [snapshot("0002"), snapshot("0001")];
    render(<App />);

    expect(harness.liveHead).toBe("0002");
    expect(harness.controllerHead).toBe("0002");
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0002");
  });

  it("uses a chat snapshot only as a not-yet-listed fast path, then prefers the enriched list record with the same id", () => {
    const chatHead = snapshot("0002", { validation: null, renders: [] });
    const enriched = snapshot("0002", {
      validation: { badge: "green", manifold: true, components: 1, volume_mm3: 8000, warning_count: 0 },
      renders: [
        {
          view: "iso",
          file: "views/iso.png",
          url: "/api/projects/p1/snapshots/0002/views/iso",
          width: 1024,
          height: 768,
          bytes: 123,
          render_ms: 4
        }
      ]
    });
    harness.chat.state = { headSnapshot: chatHead, items: [], activeTurnId: null };
    harness.snapshots = [enriched, snapshot("0001")];
    const view = render(<App />);

    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-validation", "8000");

    const notYetListed = snapshot("0003", { origin: "agent" });
    harness.chat.state = { headSnapshot: notYetListed, items: [], activeTurnId: "turn-1" };
    view.rerender(<App />);
    expect(harness.liveHead).toBe("0003");
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0003");

    // Once chat's id is represented in the list, the list's newest record is
    // authoritative even if it has already advanced again.
    harness.snapshots = [snapshot("0004"), notYetListed, enriched, snapshot("0001")];
    view.rerender(<App />);
    expect(harness.liveHead).toBe("0004");
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0004");
  });

  it("preserves an explicit historical selection across same-head enrichment, then clears it when head advances", () => {
    harness.snapshots = [snapshot("0002"), snapshot("0001")];
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select 0001" }));
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0001");

    harness.snapshots = [
      snapshot("0002", {
        validation: { badge: "green", manifold: true, components: 1, volume_mm3: 8, warning_count: 0 }
      }),
      snapshot("0001")
    ];
    view.rerender(<App />);
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0001");

    harness.snapshots = [snapshot("0003"), ...harness.snapshots];
    view.rerender(<App />);
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0003");
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-mesh-status", "missing");
  });

  it("refreshes once on snapshot_created and again when the turn finishes for late artifacts", async () => {
    const view = render(<App />);

    harness.chat.state = { headSnapshot: snapshot("0002", { origin: "agent" }), items: [], activeTurnId: "turn-1" };
    harness.chat.isStreaming = true;
    view.rerender(<App />);
    await waitFor(() => expect(harness.refresh).toHaveBeenCalledTimes(1));

    harness.chat.isStreaming = false;
    view.rerender(<App />);
    await waitFor(() => expect(harness.refresh).toHaveBeenCalledTimes(2));
  });

  it("treats the controller's full debounced override bag as authoritative even when it is empty", () => {
    harness.snapshots = [snapshot("0002")];
    harness.liveSource = { scad: "cube(size);", params: { stale_override: 99 } };
    harness.controller.debouncedValues = {};
    render(<App />);

    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-params", "{}");
  });

  it("falls back to liveSource.params before the controller initializes, then treats the (possibly empty) bag as authoritative", () => {
    harness.liveSource = { scad: "cube(size);", params: { wall: 7 } };
    harness.controller.initialized = false;
    harness.controller.debouncedValues = {};
    const view = render(<App />);

    // Before the first successful GET /params, an empty controller bag means
    // "not loaded yet" — Live uses the already-fetched project params.
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-params", JSON.stringify({ wall: 7 }));

    // Once initialized, the controller bag is authoritative.
    harness.controller.initialized = true;
    harness.controller.debouncedValues = { wall: 9 };
    view.rerender(<App />);
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-params", JSON.stringify({ wall: 9 }));

    // A legitimate revert-to-defaults empty bag stays authoritative, never
    // resurrecting the stale fallback.
    harness.controller.debouncedValues = {};
    view.rerender(<App />);
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-params", "{}");
  });

  it("refreshes snapshots through the params controller's successful-save callback", () => {
    render(<App />);
    expect(harness.controllerOnSaved).toBeTypeOf("function");

    act(() => harness.controllerOnSaved?.());
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("App project-switch reset (Issue #79)", () => {
  it("never resolves the previous project's chat head as the new project's working head, even before the new snapshot list arrives", () => {
    harness.snapshots = [snapshot("0002")];
    harness.chat.state = { headSnapshot: snapshot("0002", { origin: "agent" }), items: [], activeTurnId: null };
    const view = render(<App />);
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0002");

    // Switch projects. `useSnapshots` is mocked here, so this simulates what
    // its OWN render-time reset (tested separately in useSnapshots.test.tsx)
    // guarantees in the real app: the new project's snapshot array starts
    // empty. `chat.state.headSnapshot` is deliberately left as project p1's
    // stale value — `useChat`'s real reset effect hasn't run in this harness
    // (it's mocked), which is exactly the race `App.tsx`'s own
    // `switchingProjects` guard has to cover on its own.
    harness.project = { project: { id: "p2" }, loading: false, error: null };
    harness.snapshots = [];
    view.rerender(<App />);

    // Must not fall back to project p1's stale chat head — the whole point
    // of the fix. Before this fix, this asserted "0002".
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "none");

    // `useChat`'s own real reset effect (`hooks/useChat.ts`, keyed on
    // `projectId`) dispatches synchronously within the same effect-flush that
    // follows the render above — by the time anything else happens for p2,
    // its chat head is p2's own (here: none yet). Simulating that is what
    // makes the next step a realistic continuation rather than an
    // indefinitely-stale chat head this fix was never meant to cover.
    harness.chat.state = { headSnapshot: null, items: [], activeTurnId: null };

    // Once p2's own snapshots arrive, preview reflects them, not p1's.
    harness.snapshots = [snapshot("0005")];
    view.rerender(<App />);
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0005");
  });

  it("clears an explicit historical selection on project switch even when the new project reuses the same snapshot id (the common case — every project's history starts at 0001)", () => {
    harness.snapshots = [snapshot("0002"), snapshot("0001")];
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Select 0001" }));
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0001");

    // p2's OWN history also happens to have an "0001" — a same-id coincidence
    // that a `workingHeadId`-only comparison would miss (previous "0001" ===
    // new "0001", so nothing looked like it changed).
    harness.project = { project: { id: "p2" }, loading: false, error: null };
    harness.snapshots = [];
    view.rerender(<App />);
    harness.snapshots = [snapshot("0001", { message: "p2's own first snapshot" })];
    view.rerender(<App />);

    // The selection must have been cleared by the switch, so preview follows
    // p2's head (which happens to also be "0001") rather than a leftover,
    // never-cleared selection from p1.
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-snapshot", "0001");
    expect(screen.getByTestId("preview-state")).toHaveAttribute("data-validation", "none");
  });

  it("remounts the Preview and History subtrees on project switch, but not on an ordinary same-project snapshot selection", () => {
    harness.snapshots = [snapshot("0002"), snapshot("0001")];
    const view = render(<App />);
    expect(harness.previewMountCount).toBe(1);
    expect(harness.historyMountCount).toBe(1);

    // Selecting a snapshot within the SAME project must not remount either
    // subtree — that would lose the user's Grid/Measure/Inspect toggles on
    // every History click, a regression this fix must not introduce.
    fireEvent.click(screen.getByRole("button", { name: "Select 0001" }));
    expect(harness.previewMountCount).toBe(1);
    expect(harness.historyMountCount).toBe(1);

    // A genuine project switch DOES remount both — this is what clears
    // PreviewTab's internal measure/measureAxis/inspectOutcome state (Issue
    // #79 AC) without App having to track and clear each field itself.
    harness.project = { project: { id: "p2" }, loading: false, error: null };
    harness.snapshots = [];
    view.rerender(<App />);
    expect(harness.previewMountCount).toBe(2);
    expect(harness.historyMountCount).toBe(2);
  });
});
