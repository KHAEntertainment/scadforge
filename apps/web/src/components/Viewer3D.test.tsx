import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Viewer3D } from "./Viewer3D.js";

describe("Viewer3D", () => {
  it("counterexample: renders a graceful placeholder instead of mounting a canvas when there is no STL yet", () => {
    render(<Viewer3D stlUrl={null} />);
    expect(screen.getByTestId("viewer-placeholder")).toBeInTheDocument();
    expect(screen.getByText(/no render yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("viewer-3d")).not.toBeInTheDocument();
  });
});
