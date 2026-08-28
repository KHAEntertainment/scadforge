import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParamDefinitionWire } from "@scadforge/protocol";
import { ParamControl } from "./ParamControl.js";

const wallDef: ParamDefinitionWire = {
  name: "wall",
  type: "number",
  initial: 4,
  caption: "Bracket wall thickness",
  group: "Pipe",
  min: 2,
  max: 10,
  step: 0.5
};

describe("ParamControl", () => {
  it("renders a slider with the schema's exact min/max/step — boundary values must be reachable, not fudged", () => {
    render(<ParamControl def={wallDef} value={4} dirty={false} onChange={() => {}} />);
    const input = screen.getByLabelText("wall") as HTMLInputElement;
    expect(input.type).toBe("range");
    expect(input.min).toBe("2");
    expect(input.max).toBe("10");
    expect(input.step).toBe("0.5");
  });

  it("dragging to the exact max reports the exact max value (no off-by-one)", () => {
    const onChange = vi.fn();
    render(<ParamControl def={wallDef} value={4} dirty={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("wall"), { target: { value: "10" } });
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it("dragging to the exact min reports the exact min value (no off-by-one)", () => {
    const onChange = vi.fn();
    render(<ParamControl def={wallDef} value={4} dirty={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("wall"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it("counterexample: a number with no min/max renders a plain number input with step=\"any\"", () => {
    const def: ParamDefinitionWire = { name: "count", type: "number", initial: 3 };
    render(<ParamControl def={def} value={3} dirty={false} onChange={() => {}} />);
    const input = screen.getByLabelText("count") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.step).toBe("any");
  });

  it("counterexample: an enum/value-list renders a dropdown with each option's label", () => {
    const def: ParamDefinitionWire = {
      name: "size",
      type: "number",
      initial: 1,
      options: [
        { name: "Small", value: 1 },
        { name: "Large", value: 3 }
      ]
    };
    const onChange = vi.fn();
    render(<ParamControl def={def} value={1} dirty={false} onChange={onChange} />);
    const select = screen.getByLabelText("size") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Small", "Large"]);
    fireEvent.change(select, { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("counterexample: a boolean renders a checkbox", () => {
    const def: ParamDefinitionWire = { name: "flag", type: "boolean", initial: false };
    const onChange = vi.fn();
    render(<ParamControl def={def} value={false} dirty={false} onChange={onChange} />);
    const checkbox = screen.getByLabelText("flag") as HTMLInputElement;
    expect(checkbox.type).toBe("checkbox");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("counterexample: a string with maxLength renders a text input capped at that length", () => {
    const def: ParamDefinitionWire = { name: "label", type: "string", initial: "hi", maxLength: 5 };
    render(<ParamControl def={def} value="hi" dirty={false} onChange={() => {}} />);
    const input = screen.getByLabelText("label") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.maxLength).toBe(5);
  });

  it("counterexample: a vector with no options shows a read-only unsupported note instead of a broken editor", () => {
    const def: ParamDefinitionWire = { name: "offset", type: "vector", initial: [1, 2, 3] };
    render(<ParamControl def={def} value={[1, 2, 3]} dirty={false} onChange={() => {}} />);
    expect(screen.getByTestId("param-unsupported-offset")).toHaveTextContent("unsupported parameter type: vector");
  });

  it("shows the caption as a description and a dirty indicator while a local edit is unconfirmed", () => {
    render(<ParamControl def={wallDef} value={4} dirty onChange={() => {}} />);
    expect(screen.getByText("Bracket wall thickness")).toBeInTheDocument();
    expect(screen.getByTestId("param-dirty-wall")).toBeInTheDocument();
  });
});
