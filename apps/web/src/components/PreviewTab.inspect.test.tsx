// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParamValues } from "@scadforge/protocol";
import type { UseWasmPreviewResult } from "../wasm/index.js";
import type { Viewer3DProps } from "./Viewer3D.js";
import type { InspectionOutcome } from "./inspect/inspectionTypes.js";

/**
 * Same seam as `PreviewTab.measure.test.tsx`: the 3D canvas can't run under
 * jsdom, so `Viewer3D` is mocked at its props boundary. The toggle and
 * readout are PreviewTab's own DOM, fully testable here; the highlight/pick
 * geometry is covered by `surfaceRegion.test.ts` / `highlightGeometry.test.ts`
 * and the browser walkthrough.
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

function idleResult(overrides: Partial<UseWasmPreviewResult> = {}): UseWasmPreviewResult {
  return { status: "idle", objectUrl: null, stderr: null, lastRenderMs: null, coldInit: null, ...overrides };
}

function lastViewerProps(): Viewer3DProps {
  const calls = viewerPropsSpy.mock.calls;
  return calls[calls.length - 1][0];
}

/** Simulates Viewer3D reporting an inspection outcome (or a clear, via null). */
function emitInspect(outcome: InspectionOutcome | null) {
  act(() => {
    lastViewerProps().onInspect?.(outcome);
  });
}

const RECOGNIZED_HOLE: InspectionOutcome = {
  status: "recognized",
  inspection: {
    kind: "radial",
    surface: "hole",
    axis: "z",
    center: { x: 0, y: 0, z: 10 },
    diameterMm: 32,
    evidence: { segments: 48, arcDegrees: 360, maxDeviationMm: 0.0004, axialLengthMm: 20 }
  },
  regionTriangles: new Uint32Array([1, 2, 3])
};

const REFUSED_WITH_MARKUP: InspectionOutcome = {
  status: "refused",
  refusal: { code: "planar", message: "This is a flat surface with <b>x</b> inside it." }
};

describe("PreviewTab — inspect toggle", () => {
  it("is off by default and disabled without a server mesh, and never reaches the viewer", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl={null} pngUrls={{}} liveScad={null} liveParams={{}} />);

    const toggle = screen.getByTestId("inspect-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toBeDisabled();
    expect(lastViewerProps().inspect).toBe(false);
  });

  it("is enabled in 3D mode once a server mesh exists, and passes inspect through to the viewer only then", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    const toggle = screen.getByTestId("inspect-toggle");
    expect(toggle).not.toBeDisabled();
    expect(lastViewerProps().inspect).toBe(false); // not clicked yet

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(lastViewerProps().inspect).toBe(true);
    expect(screen.queryByTestId("inspect-readout")).not.toBeInTheDocument(); // on, but nothing inspected yet
  });

  it("is disabled in Live mode and stops reaching the viewer", () => {
    useWasmPreviewMock.mockReturnValue(idleResult({ status: "ok", objectUrl: "blob:x" }));
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad="cube(1);" liveParams={{}} />);

    fireEvent.click(screen.getByTestId("inspect-toggle"));
    expect(lastViewerProps().inspect).toBe(true);

    fireEvent.click(screen.getByTestId("view-button-live"));
    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();
    expect(screen.getByTestId("inspect-toggle")).toHaveAttribute("title", expect.stringMatching(/server render/i));
    expect(lastViewerProps().inspect).toBe(false);
  });

  it("is disabled on a fixed PNG view and stops reaching the viewer", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{ iso: "/iso.png" }} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("inspect-toggle"));
    fireEvent.click(screen.getByTestId("view-button-iso"));

    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();
    expect(lastViewerProps().inspect).toBe(false);
  });
});

describe("PreviewTab — inspect readout", () => {
  it("shows a recognized readout with diameter, side, axis and snapshot provenance", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" snapshotId="0007" pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("inspect-toggle"));
    emitInspect(RECOGNIZED_HOLE);

    const readout = screen.getByTestId("inspect-readout");
    expect(readout).toHaveTextContent("Hole");
    expect(readout).toHaveTextContent("Ø 32");
    expect(readout).toHaveTextContent("Axis Z");
    expect(readout).toHaveTextContent("Measured from snapshot 0007");
    expect(readout).toHaveTextContent("48 segments");
  });

  it("counterexample: no snapshot yet -- provenance names the current server render, not a fake id", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" snapshotId={null} pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("inspect-toggle"));
    emitInspect(RECOGNIZED_HOLE);

    expect(screen.getByTestId("inspect-readout")).toHaveTextContent("Measured from the current server render");
  });

  it("counterexample: a refusal message containing markup renders as literal text, never parsed", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);

    fireEvent.click(screen.getByTestId("inspect-toggle"));
    emitInspect(REFUSED_WITH_MARKUP);

    const readout = screen.getByTestId("inspect-readout");
    expect(readout.querySelector("b")).toBeNull();
    expect(readout).toHaveTextContent("This is a flat surface with <b>x</b> inside it.");
  });

  it("the setup CTA is disabled with its note in both the recognized and refused states, and 'Editable: no binding' is recognized-only", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);
    fireEvent.click(screen.getByTestId("inspect-toggle"));

    emitInspect(RECOGNIZED_HOLE);
    expect(screen.getByTestId("inspect-setup-cta")).toBeDisabled();
    expect(screen.getByTestId("inspect-readout")).toHaveTextContent("Setup arrives with the editor.");
    expect(screen.getByTestId("inspect-readout")).toHaveTextContent("Editable: no binding");

    emitInspect(REFUSED_WITH_MARKUP);
    expect(screen.getByTestId("inspect-setup-cta")).toBeDisabled();
    expect(screen.getByTestId("inspect-readout")).toHaveTextContent("Setup arrives with the editor.");
    expect(screen.getByTestId("inspect-readout")).not.toHaveTextContent("Editable: no binding");
  });

  it("clears on a snapshot change", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    const { rerender } = render(<PreviewTab stlUrl="/mesh.stl" snapshotId="0001" pngUrls={{}} liveScad={null} liveParams={{}} />);
    fireEvent.click(screen.getByTestId("inspect-toggle"));
    emitInspect(RECOGNIZED_HOLE);
    expect(screen.getByTestId("inspect-readout")).toBeInTheDocument();

    rerender(<PreviewTab stlUrl="/mesh.stl" snapshotId="0002" pngUrls={{}} liveScad={null} liveParams={{}} />);
    expect(screen.queryByTestId("inspect-readout")).not.toBeInTheDocument();
  });

  it("clears on a stlUrl change", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    const { rerender } = render(<PreviewTab stlUrl="/mesh-a.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);
    fireEvent.click(screen.getByTestId("inspect-toggle"));
    emitInspect(RECOGNIZED_HOLE);
    expect(screen.getByTestId("inspect-readout")).toBeInTheDocument();

    rerender(<PreviewTab stlUrl="/mesh-b.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);
    expect(screen.queryByTestId("inspect-readout")).not.toBeInTheDocument();
  });

  it("clears on a mode change", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{ iso: "/iso.png" }} liveScad={null} liveParams={{}} />);
    fireEvent.click(screen.getByTestId("inspect-toggle"));
    emitInspect(RECOGNIZED_HOLE);
    expect(screen.getByTestId("inspect-readout")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("view-button-iso"));
    expect(screen.queryByTestId("inspect-readout")).not.toBeInTheDocument();
  });

  it("clears when the toggle is turned off", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);
    const toggle = screen.getByTestId("inspect-toggle");
    fireEvent.click(toggle);
    emitInspect(RECOGNIZED_HOLE);
    expect(screen.getByTestId("inspect-readout")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId("inspect-readout")).not.toBeInTheDocument();
  });

  it("clears when the viewer reports a null outcome (empty-space click or Esc)", () => {
    useWasmPreviewMock.mockReturnValue(idleResult());
    render(<PreviewTab stlUrl="/mesh.stl" pngUrls={{}} liveScad={null} liveParams={{}} />);
    fireEvent.click(screen.getByTestId("inspect-toggle"));
    emitInspect(RECOGNIZED_HOLE);
    expect(screen.getByTestId("inspect-readout")).toBeInTheDocument();

    emitInspect(null);
    expect(screen.queryByTestId("inspect-readout")).not.toBeInTheDocument();
  });
});
