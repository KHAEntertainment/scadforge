// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParamValues } from "@scadforge/protocol";
import type { UseWasmPreviewResult } from "../wasm/index.js";
import type { Viewer3DProps } from "./Viewer3D.js";
import type { BBox } from "./measure.js";

/**
 * The 3D canvas can't run under jsdom, so Viewer3D is mocked at its props
 * seam: the measure UI (toggle, axis selector, readout) is PreviewTab's own
 * DOM and is fully testable, while the overlay geometry is covered by
 * `measure.test.ts` and the browser walkthrough.
 */
const viewerPropsSpy = vi.fn<(props: Viewer3DProps) => void>();
vi.mock("./Viewer3D.js", () => ({
  Viewer3D: (props: Viewer3DProps) => {
    viewerPropsSpy(props);
    return <div data-testid="viewer-3d" />;
  }
}));

const useWasmPreviewMock = vi.fn<(scad: string | null, params: ParamValues, enabled: boolean) => UseWasmPreviewResult>();
vi.mock("../wasm/index.js", () => ({
  useWasmPreview: (scad: string | null, params: ParamValues, enabled: boolean) => useWasmPreviewMock(scad, params, enabled)
}));

// Imported AFTER the mocks so PreviewTab picks them up.
const { PreviewTab } = await import("./PreviewTab.js");

const BRACKET_BBOX: BBox = { min: { x: 5, y: -2, z: 1 }, max: { x: 105, y: 58, z: 13 } };

function idleResult(overrides: Partial<UseWasmPreviewResult> = {}): UseWasmPreviewResult {
  return { status: "idle", objectUrl: null, stderr: null, lastRenderMs: null, coldInit: null, ...overrides };
}

function lastViewerProps(): Viewer3DProps {
  const calls = viewerPropsSpy.mock.calls;
  return calls[calls.length - 1][0];
}

/** Simulates the mesh load: Viewer3D reports the displayed mesh's bbox upward. */
function emitBoundingBox(box: BBox | null) {
  // The real callback fires from a three.js loader effect, outside React's
  // event flow — wrap so the state update flushes before assertions.
  act(() => {
    lastViewerProps().onBoundingBox?.(box);
  });
}

describe("PreviewTab — measurement overlay", () => {
  it("Measure toggle is off by default: no axis controls, no readout, viewer told not to measure", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    expect(screen.queryByTestId("measure-readout")).not.toBeInTheDocument();
    expect(screen.queryByTestId("measure-axis-all")).not.toBeInTheDocument();
    expect(lastViewerProps().measure).toBe(false);
  });

  it("toggling Measure on reveals axis controls and passes measure props through to the viewer", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("measure-toggle"));

    expect(screen.getByTestId("measure-toggle")).toHaveAttribute("aria-pressed", "true");
    for (const axis of ["all", "x", "y", "z"]) {
      expect(screen.getByTestId(`measure-axis-${axis}`)).toBeInTheDocument();
    }
    expect(lastViewerProps().measure).toBe(true);
    expect(lastViewerProps().measureAxis).toBe("all");
  });

  it("readout shows all three extents in mm, labelled as derived from the preview mesh", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("measure-toggle"));
    emitBoundingBox(BRACKET_BBOX);

    const readout = screen.getByTestId("measure-readout");
    expect(readout).toHaveTextContent("X 100 mm");
    expect(readout).toHaveTextContent("Y 60 mm");
    expect(readout).toHaveTextContent("Z 12 mm");
    expect(readout).toHaveTextContent(/derived from preview mesh/i);
  });

  it("axis selection flows to the viewer as the face-to-face focus", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("measure-toggle"));
    fireEvent.click(screen.getByTestId("measure-axis-z"));

    expect(screen.getByTestId("measure-axis-z")).toHaveAttribute("aria-pressed", "true");
    expect(lastViewerProps().measureAxis).toBe("z");
  });

  it("counterexample: no mesh loaded yet — readout explains instead of showing stale or NaN dimensions", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl={null} pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("measure-toggle"));

    expect(screen.getByTestId("measure-readout")).toHaveTextContent(/no mesh to measure yet/i);
  });

  it("counterexample: mesh unload clears the readout (bbox callback reports null)", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("measure-toggle"));
    emitBoundingBox(BRACKET_BBOX);
    expect(screen.getByTestId("measure-readout")).toHaveTextContent("X 100 mm");

    emitBoundingBox(null);
    expect(screen.getByTestId("measure-readout")).toHaveTextContent(/no mesh to measure yet/i);
  });

  it("toggling Measure off hides the controls and stops the viewer measuring", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("measure-toggle"));
    emitBoundingBox(BRACKET_BBOX);
    fireEvent.click(screen.getByTestId("measure-toggle"));

    expect(screen.queryByTestId("measure-readout")).not.toBeInTheDocument();
    expect(lastViewerProps().measure).toBe(false);
  });
});
