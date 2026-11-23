// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Binding } from "@scadforge/protocol";
import { parseTypedValue, presentationUnit, toParameterValue, toPresentationValue } from "./featureValue.js";

function radial(parameterMeaning: "radius" | "diameter", presentation: "radius" | "diameter"): Binding {
  return { kind: "radial", parameter: "hole", center: [0, 0, 0], axis: [0, 0, 1], parameterMeaning, presentation };
}

describe("featureValue", () => {
  it("does not convert when the parameter's meaning equals its presentation", () => {
    for (const unit of ["radius", "diameter"] as const) {
      expect(toPresentationValue(radial(unit, unit), 2.5)).toBe(2.5);
      expect(toParameterValue(radial(unit, unit), 2.5)).toBe(2.5);
    }
  });

  it("shows a radius parameter as a diameter, and converts typed diameters back to the radius", () => {
    const binding = radial("radius", "diameter");
    expect(presentationUnit(binding)).toBe("diameter");
    expect(toPresentationValue(binding, 2.5)).toBe(5);
    expect(toParameterValue(binding, 5)).toBe(2.5);
    expect(toParameterValue(binding, toPresentationValue(binding, 3.1))).toBe(3.1);
  });

  it("shows a diameter parameter as a radius", () => {
    const binding = radial("diameter", "radius");
    expect(toPresentationValue(binding, 8)).toBe(4);
    expect(toParameterValue(binding, 4)).toBe(8);
  });

  it("edits a linear feature's parameter value directly", () => {
    const binding: Binding = { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 2, offset: 1, anchor: "min" } };
    expect(presentationUnit(binding)).toBeNull();
    expect(toPresentationValue(binding, 3)).toBe(3);
    expect(toParameterValue(binding, 3)).toBe(3);
  });

  it("parses empty or blank text as NaN, not 0", () => {
    expect(parseTypedValue("")).toBeNaN();
    expect(parseTypedValue("   ")).toBeNaN();
    expect(parseTypedValue(" 4.5 ")).toBe(4.5);
    expect(parseTypedValue("1e309")).toBe(Number.POSITIVE_INFINITY);
    expect(parseTypedValue("abc")).toBeNaN();
  });
});
