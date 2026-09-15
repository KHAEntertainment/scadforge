// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferGeometry } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { isEscapeKey, isInspectClick, StlModel, Viewer3D } from "./Viewer3D.js";
import { INSPECTION_THRESHOLDS } from "./inspect/thresholds.js";

afterEach(() => vi.restoreAllMocks());

describe("active STL loading feedback", () => {
  it("shows loading while the initial GET is delayed and only renders the published geometry", () => {
    let complete!: (geometry: BufferGeometry) => void;
    vi.spyOn(STLLoader.prototype, "load").mockImplementation((_url, done) => { complete = done; });
    const show = vi.fn((geometry: BufferGeometry) => <div>{geometry.uuid}</div>);
    render(<StlModel url="/delayed.stl">{show}</StlModel>);
    expect(screen.getByText("Loading model…")).toBeVisible();
    expect(show).not.toHaveBeenCalled();
    const geometry = new BufferGeometry();
    act(() => complete(geometry));
    expect(screen.queryByText("Loading model…")).not.toBeInTheDocument();
    expect(screen.getByText(geometry.uuid)).toBeVisible();
  });

  it("keeps loading through superseded completions and a return to a disposed URL", () => {
    const pending: Array<(geometry: BufferGeometry) => void> = [];
    vi.spyOn(STLLoader.prototype, "load").mockImplementation((_url, done) => { pending.push(done); });
    const show = (geometry: BufferGeometry) => <div>{geometry.uuid}</div>;
    const { rerender } = render(<StlModel url="/a.stl">{show}</StlModel>);
    rerender(<StlModel url="/b.stl">{show}</StlModel>);
    const stale = new BufferGeometry();
    const disposed = vi.spyOn(stale, "dispose");
    act(() => pending[0](stale));
    expect(disposed).toHaveBeenCalledOnce();
    expect(screen.getByText("Loading model…")).toBeVisible();
    expect(screen.queryByText(stale.uuid)).not.toBeInTheDocument();
    const active = new BufferGeometry();
    act(() => pending[1](active));
    expect(screen.getByText(active.uuid)).toBeVisible();
    rerender(<StlModel url="/a.stl">{show}</StlModel>);
    expect(screen.getByText("Loading model…")).toBeVisible();
    expect(screen.queryByText(active.uuid)).not.toBeInTheDocument();
    const fresh = new BufferGeometry();
    act(() => pending[2](fresh));
    expect(screen.queryByText("Loading model…")).not.toBeInTheDocument();
    expect(screen.getByText(fresh.uuid)).toBeVisible();
  });
});

describe("Viewer3D", () => {
  it("counterexample: renders a graceful placeholder instead of mounting a canvas when there is no STL yet", () => {
    render(<Viewer3D stlUrl={null} />);
    expect(screen.getByTestId("viewer-placeholder")).toBeInTheDocument();
    expect(screen.getByText(/no render yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("viewer-3d")).not.toBeInTheDocument();
  });
});

describe("isInspectClick", () => {
  it("counts pointer travel at or under the threshold as a click", () => {
    expect(isInspectClick(0)).toBe(true);
    expect(isInspectClick(INSPECTION_THRESHOLDS.clickMaxDeltaPx)).toBe(true);
  });

  it("counterexample: travel past the threshold is a drag, not a click -- orbiting must never select", () => {
    expect(isInspectClick(INSPECTION_THRESHOLDS.clickMaxDeltaPx + 0.01)).toBe(false);
    expect(isInspectClick(50)).toBe(false);
  });
});

describe("isEscapeKey", () => {
  it("recognizes the Escape key", () => {
    expect(isEscapeKey({ key: "Escape" })).toBe(true);
  });

  it("counterexample: any other key does not clear the selection", () => {
    expect(isEscapeKey({ key: "Enter" })).toBe(false);
    expect(isEscapeKey({ key: "e" })).toBe(false);
  });
});
