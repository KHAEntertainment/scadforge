// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatMm } from "../measure.js";
import {
  notAxisAlignedRefusal,
  notCircularRefusal,
  partialArcRefusal,
  planarRefusal,
  tooCoarseRefusal
} from "./refusals.js";

describe("refusals", () => {
  it("planarRefusal matches the scope text verbatim (no placeholders)", () => {
    expect(planarRefusal()).toEqual({
      code: "planar",
      message: "This is a flat surface. Surface inspection measures cylindrical walls only."
    });
  });

  it("notAxisAlignedRefusal matches the scope text verbatim (no placeholders)", () => {
    expect(notAxisAlignedRefusal()).toEqual({
      code: "not-axis-aligned",
      message: "This surface isn't a cylinder aligned with the X, Y or Z axis."
    });
  });

  it("tooCoarseRefusal fills {n} with the segment count, formatMm-style", () => {
    expect(tooCoarseRefusal(6)).toEqual({
      code: "too-coarse",
      message: "This curve has only 6 segments — too few to tell a cylinder from a polygonal prism. Raise $fn for this feature to inspect it."
    });
    expect(tooCoarseRefusal(8)).toEqual({
      code: "too-coarse",
      message: "This curve has only 8 segments — too few to tell a cylinder from a polygonal prism. Raise $fn for this feature to inspect it."
    });
  });

  it("partialArcRefusal fills {deg} with the arc coverage, formatMm-style", () => {
    expect(partialArcRefusal(90)).toEqual({
      code: "partial-arc",
      message: "Only 90° of this curve is present — too little to confirm a cylindrical feature."
    });
    expect(partialArcRefusal(179.5)).toEqual({
      code: "partial-arc",
      message: `Only ${formatMm(179.5)}° of this curve is present — too little to confirm a cylindrical feature.`
    });
  });

  it("notCircularRefusal fills {dev} with 3 decimals, not formatMm's one decimal", () => {
    // A deviation just over the 0.01 mm limit: formatMm(0.0123) would
    // round to "0" mm, misleadingly reading as an exact circle.
    expect(notCircularRefusal(0.0123)).toEqual({
      code: "not-circular",
      message: "These facets don't fit a single circle (off by up to 0.012 mm), so no diameter is shown."
    });
    expect(notCircularRefusal(0.5)).toEqual({
      code: "not-circular",
      message: "These facets don't fit a single circle (off by up to 0.500 mm), so no diameter is shown."
    });
  });

  it("every builder's message equals the scope text once its placeholder is filled", () => {
    const cases: { built: { code: string; message: string }; template: string; value: number; formatted: string }[] = [
      { built: tooCoarseRefusal(6), template: "This curve has only {n} segments — too few to tell a cylinder from a polygonal prism. Raise $fn for this feature to inspect it.", value: 6, formatted: formatMm(6) },
      { built: partialArcRefusal(150), template: "Only {deg}° of this curve is present — too little to confirm a cylindrical feature.", value: 150, formatted: formatMm(150) },
      { built: notCircularRefusal(0.12), template: "These facets don't fit a single circle (off by up to {dev} mm), so no diameter is shown.", value: 0.12, formatted: (0.12).toFixed(3) }
    ];
    for (const { built, template, formatted } of cases) {
      const expected = template.replace(/\{(n|deg|dev)\}/, formatted);
      expect(built.message).toBe(expected);
    }
  });
});
