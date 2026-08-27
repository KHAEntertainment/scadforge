import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UseWasmPreviewResult } from "../wasm/index.js";

const useWasmPreviewMock = vi.fn<[], UseWasmPreviewResult>();
vi.mock("../wasm/index.js", () => ({
  useWasmPreview: (...args: unknown[]) => useWasmPreviewMock(...(args as []))
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
