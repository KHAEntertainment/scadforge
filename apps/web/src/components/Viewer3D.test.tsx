import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isEscapeKey, isInspectClick, Viewer3D } from "./Viewer3D.js";
import { INSPECTION_THRESHOLDS } from "./inspect/thresholds.js";

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
