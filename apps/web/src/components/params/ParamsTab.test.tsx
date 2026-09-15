// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParamsControllerResult } from "./useParamsController.js";
import { ParamsTab } from "./ParamsTab.js";

function makeController(overrides: Partial<ParamsControllerResult> = {}): ParamsControllerResult {
  return {
    loading: false,
    loadError: null,
    title: "bracket",
    parameters: [],
    values: {},
    debouncedValues: {},
    dirty: new Set(),
    saving: false,
    saveError: null,
    initialized: true,
    setValue: vi.fn(),
    ...overrides
  };
}

describe("ParamsTab", () => {
  it("counterexample: empty schema (model with no annotated params) shows a helpful empty state, not a broken tab", () => {
    render(<ParamsTab controller={makeController()} onAskAgent={() => {}} />);
    expect(screen.getByTestId("params-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("ask-agent-button")).toBeInTheDocument();
  });

  it("shows a loading state distinct from the empty state", () => {
    render(<ParamsTab controller={makeController({ loading: true })} onAskAgent={() => {}} />);
    expect(screen.getByTestId("params-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("params-empty-state")).not.toBeInTheDocument();
  });

  it("shows a load error distinct from the empty state", () => {
    render(<ParamsTab controller={makeController({ loadError: "network down" })} onAskAgent={() => {}} />);
    expect(screen.getByTestId("params-load-error")).toHaveTextContent("network down");
    expect(screen.queryByTestId("params-empty-state")).not.toBeInTheDocument();
  });

  it('"Ask agent to add a parameter" composes a chat message rather than fabricating a schema client-side', () => {
    const onAskAgent = vi.fn();
    render(<ParamsTab controller={makeController()} onAskAgent={onAskAgent} />);

    fireEvent.change(screen.getByLabelText("Parameter request"), { target: { value: "a mounting hole diameter" } });
    fireEvent.click(screen.getByTestId("ask-agent-button"));

    expect(onAskAgent).toHaveBeenCalledWith(expect.stringContaining("a mounting hole diameter"));
    expect(onAskAgent.mock.calls[0][0]).not.toMatch(/\{|\[|type:|min:|max:/); // no fabricated schema payload
  });

  it("renders controls grouped under section headings", () => {
    const controller = makeController({
      parameters: [
        { name: "wall", type: "number", initial: 4, min: 2, max: 10, group: "Pipe" },
        { name: "count", type: "number", initial: 1, group: "Array" }
      ],
      values: { wall: 4, count: 1 }
    });
    render(<ParamsTab controller={controller} onAskAgent={() => {}} />);

    expect(screen.getByTestId("param-group-Pipe")).toBeInTheDocument();
    expect(screen.getByTestId("param-group-Array")).toBeInTheDocument();
    expect(screen.getByTestId("param-control-wall")).toBeInTheDocument();
    expect(screen.getByTestId("param-control-count")).toBeInTheDocument();
  });

  it("shows the server-authority saving/saved status", () => {
    const controller = makeController({
      parameters: [{ name: "wall", type: "number", initial: 4, min: 0, max: 10 }],
      values: { wall: 4 },
      saving: true
    });
    render(<ParamsTab controller={controller} onAskAgent={() => {}} />);
    expect(screen.getByTestId("params-status")).toHaveTextContent(/saving/i);
  });

  it("surfaces a rejected-write error without hiding the rest of the form", () => {
    const controller = makeController({
      parameters: [{ name: "wall", type: "number", initial: 4, min: 0, max: 10 }],
      values: { wall: 4 },
      saveError: "'wall' value 99 is above its max of 10."
    });
    render(<ParamsTab controller={controller} onAskAgent={() => {}} />);
    expect(screen.getByTestId("params-save-error")).toHaveTextContent(/above its max/);
    expect(screen.getByTestId("param-control-wall")).toBeInTheDocument();
  });

  it("a dirty (in-flight) control renders its dirty indicator", () => {
    const controller = makeController({
      parameters: [{ name: "wall", type: "number", initial: 4, min: 0, max: 10 }],
      values: { wall: 6 },
      dirty: new Set(["wall"])
    });
    render(<ParamsTab controller={controller} onAskAgent={() => {}} />);
    expect(screen.getByTestId("param-dirty-wall")).toBeInTheDocument();
  });
});
