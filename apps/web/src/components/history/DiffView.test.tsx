import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView, DIFF_TRUNCATE_LINES } from "./DiffView.js";

describe("DiffView", () => {
  it("shows a prompt when nothing is selected yet", () => {
    render(<DiffView loading={false} error={null} diff={null} snapshotId={null} parentId={null} />);
    expect(screen.getByTestId("diff-empty-selection")).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    render(<DiffView loading={true} error={null} diff={null} snapshotId="0002" parentId={null} />);
    expect(screen.getByText(/loading diff/i)).toBeInTheDocument();
  });

  it("surfaces a fetch error", () => {
    render(<DiffView loading={false} error="boom" diff={null} snapshotId="0002" parentId={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });

  it("counterexample: the first snapshot (empty diff, per the frozen contract) renders an explicit empty state, not a blank pane", () => {
    render(<DiffView loading={false} error={null} diff="" snapshotId="0001" parentId={null} />);
    expect(screen.getByTestId("diff-first-snapshot")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-view")).not.toBeInTheDocument();
  });

  it("renders unified diff lines with add/remove styling", () => {
    const diff = ["--- 0001/model.scad", "+++ 0002/model.scad", "@@ -1,1 +1,1 @@", "-cube([10,10,10]);", "+cube([20,20,20]);"].join("\n");
    render(<DiffView loading={false} error={null} diff={diff} snapshotId="0002" parentId="0001" />);
    const view = screen.getByTestId("diff-view");
    expect(view).toHaveTextContent("-cube([10,10,10]);");
    expect(view).toHaveTextContent("+cube([20,20,20]);");
    expect(screen.queryByTestId("diff-expand")).not.toBeInTheDocument();
  });

  it("counterexample: a very large diff is truncated with an expand affordance instead of rendering every line up front", async () => {
    const totalLines = DIFF_TRUNCATE_LINES + 250;
    const diff = Array.from({ length: totalLines }, (_, i) => `+line ${i}`).join("\n");
    const { container } = render(<DiffView loading={false} error={null} diff={diff} snapshotId="0002" parentId="0001" />);

    expect(container.querySelectorAll(".diff-line")).toHaveLength(DIFF_TRUNCATE_LINES);

    const expandButton = screen.getByTestId("diff-expand");
    expect(expandButton).toHaveTextContent("250 more lines");

    await userEvent.click(expandButton);
    expect(container.querySelectorAll(".diff-line")).toHaveLength(totalLines);
    expect(screen.queryByTestId("diff-expand")).not.toBeInTheDocument();
  });
});
