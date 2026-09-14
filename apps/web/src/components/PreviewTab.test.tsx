import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParamValues } from "@scadforge/protocol";
import type { UseWasmPreviewResult } from "../wasm/index.js";

const useWasmPreviewMock = vi.fn<(scad: string | null, params: ParamValues, enabled: boolean) => UseWasmPreviewResult>();
vi.mock("../wasm/index.js", () => ({
  useWasmPreview: (scad: string | null, params: ParamValues, enabled: boolean) => useWasmPreviewMock(scad, params, enabled)
}));

// Imported AFTER the mock so PreviewTab picks up the mocked hook.
const { PreviewTab } = await import("./PreviewTab.js");

function idleResult(overrides: Partial<UseWasmPreviewResult> = {}): UseWasmPreviewResult {
  return { status: "idle", objectUrl: null, stderr: null, lastRenderMs: null, coldInit: null, ...overrides };
}

describe("PreviewTab — Live mode (Issue #31)", () => {
  it("counterexample: WASM render failed/timed out — keeps the last SERVER render with a stale indicator, never blank (CLAUDE.md rule 6, binding AC)", () => {
    useWasmPreviewMock.mockReturnValue(idleResult({ status: "error", stderr: "ERROR: Parser error in file" }));

    render(
      <PreviewTab stlUrl="/api/projects/p1/snapshots/0002/views/server.stl" pngUrls={{}} liveScad="cube(1);" liveParams={{}} />
    );

    fireEvent.click(screen.getByTestId("view-button-live"));

    const indicator = screen.getByTestId("live-stale-indicator");
    expect(indicator).toHaveTextContent(/showing last server render/i);
    expect(indicator).toHaveTextContent("ERROR: Parser error in file");
    // Server-authoritative mesh still renders (Viewer3D got the server stlUrl, not null/blank).
    expect(screen.getByTestId("viewer-3d")).toBeInTheDocument();
  });

  it("shows the live mesh (not stale) once the WASM render succeeds", () => {
    useWasmPreviewMock.mockReturnValue(idleResult({ status: "ok", objectUrl: "blob:live-mesh", lastRenderMs: 1600 }));

    render(<PreviewTab stlUrl={null} pngUrls={{}} liveScad="cube(1);" liveParams={{}} />);
    fireEvent.click(screen.getByTestId("view-button-live"));

    expect(screen.getByTestId("live-status")).toHaveTextContent(/live preview\./i);
    expect(screen.queryByTestId("live-stale-indicator")).not.toBeInTheDocument();
    expect(screen.getByTestId("viewer-3d")).toBeInTheDocument();
  });

  it("counterexample: no project source loaded yet — Live button is disabled instead of spawning a worker on empty input", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl={null} pngUrls={{}} liveScad={null} liveParams={{}} />);
    expect(screen.getByTestId("view-button-live")).toBeDisabled();
  });

  it("orbit mode never invokes the wasm hook while enabled=false", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl={null} pngUrls={{}} liveScad="cube(1);" liveParams={{}} />);
    // hook is always called (rules of hooks) but with enabled=false on the default "orbit" mode
    expect(useWasmPreviewMock).toHaveBeenCalledWith("cube(1);", {}, false);
  });
});

describe("PreviewTab — Build CTA (Issue #78)", () => {
  it("shows an inline Build button in the empty-mesh state that calls the same onBuild as the header", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    const onBuild = vi.fn();
    render(
      <PreviewTab
        stlUrl={null}
        meshStatus="absent"
        snapshotId="0004"
        pngUrls={{}}
        liveScad={null}
        liveParams={{}}
        onBuild={onBuild}
        building={false}
        buildDisabled={false}
        buildDisabledReason={null}
      />
    );

    expect(screen.getByTestId("preview-build-cta")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-placeholder")).toHaveTextContent(/build validates the model and creates the mesh/i);
    const button = screen.getByTestId("preview-build-button");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onBuild).toHaveBeenCalledTimes(1);
  });

  it("disables the inline Build button with a tooltip naming the reason (dirty source, saving, active turn, building)", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(
      <PreviewTab
        stlUrl={null}
        meshStatus="absent"
        snapshotId="0004"
        pngUrls={{}}
        liveScad={null}
        liveParams={{}}
        onBuild={vi.fn()}
        building={false}
        buildDisabled={true}
        buildDisabledReason="Save or discard your source edits before building."
      />
    );

    const button = screen.getByTestId("preview-build-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Save or discard your source edits before building.");
  });

  it("counterexample: a snapshot WITH a mesh never shows the Build CTA", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(
      <PreviewTab
        stlUrl="/mesh.stl"
        meshStatus="ready"
        snapshotId="0004"
        pngUrls={{}}
        liveScad={null}
        liveParams={{}}
        onBuild={vi.fn()}
      />
    );

    expect(screen.queryByTestId("preview-build-cta")).not.toBeInTheDocument();
  });

  it("counterexample: no onBuild handler — no CTA is rendered even with an empty mesh", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl={null} meshStatus="absent" snapshotId="0004" pngUrls={{}} liveScad={null} liveParams={{}} />);

    expect(screen.queryByTestId("preview-build-cta")).not.toBeInTheDocument();
  });

  it("selecting a historical snapshot with no mesh disables Build with the head-targeting reason (AC5)", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(
      <PreviewTab
        stlUrl={null}
        meshStatus="absent"
        snapshotId="0001"
        pngUrls={{}}
        liveScad={null}
        liveParams={{}}
        historical
        onBuild={vi.fn()}
        buildDisabled={true}
        buildDisabledReason="Build validates the current head; select the head to build"
      />
    );

    const button = screen.getByTestId("preview-build-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Build validates the current head; select the head to build");
  });
});
