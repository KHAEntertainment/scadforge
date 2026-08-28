import { describe, expect, it } from "vitest";
import type { ParamDefinitionWire } from "@scadforge/protocol";
import { controlKind } from "./controlKind.js";

function def(overrides: Partial<ParamDefinitionWire> & Pick<ParamDefinitionWire, "name" | "type">): ParamDefinitionWire {
  return { initial: 0, ...overrides };
}

describe("controlKind", () => {
  it("a number with both min AND max -> slider", () => {
    expect(controlKind(def({ name: "wall", type: "number", min: 2, max: 10, step: 0.5 }))).toBe("slider");
  });

  it("counterexample: a number with no min/max -> plain number input, not a slider", () => {
    expect(controlKind(def({ name: "wall", type: "number" }))).toBe("number");
  });

  it("counterexample: a number with only min (no max) -> plain number input", () => {
    expect(controlKind(def({ name: "wall", type: "number", min: 2 }))).toBe("number");
  });

  it("counterexample: a number with only max (no min) -> plain number input", () => {
    expect(controlKind(def({ name: "wall", type: "number", max: 10 }))).toBe("number");
  });

  it("boolean -> checkbox", () => {
    expect(controlKind(def({ name: "flag", type: "boolean" }))).toBe("checkbox");
  });

  it("string with maxLength -> text", () => {
    expect(controlKind(def({ name: "label", type: "string", maxLength: 12 }))).toBe("text");
  });

  it("counterexample: an enum/value-list (`options`) always renders a dropdown, regardless of `type`", () => {
    expect(
      controlKind(def({ name: "size", type: "number", min: 1, max: 3, options: [{ name: "S", value: 1 }, { name: "L", value: 3 }] }))
    ).toBe("dropdown");
    expect(controlKind(def({ name: "color", type: "string", options: [{ name: "red", value: "red" }] }))).toBe("dropdown");
  });

  it("counterexample: a vector with no options is unsupported (no scalar Customizer widget exists for it)", () => {
    expect(controlKind(def({ name: "offset", type: "vector" }))).toBe("unsupported");
  });
});
