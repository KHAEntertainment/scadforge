// @scadforge/scad-core — eligibility.ts tests (Issue #91, S3-B ticket B5).
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { EditorFeature } from "@scadforge/protocol";
import type { ParamSchema } from "../types.js";
import { editorEligibility } from "./eligibility.js";

const PROJECT_ID = "hinged-box"; // real project ids are slugs, never UUIDs -- see the Tech Lead's contract-defect note

function linearFeature(id: string, parameter: string): EditorFeature {
  return {
    featureId: id,
    label: "wall",
    projectId: PROJECT_ID,
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter, axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } }
  };
}

function radialFeature(id: string, parameter: string, axis: readonly [number, number, number]): EditorFeature {
  return {
    featureId: id,
    label: "bore",
    projectId: PROJECT_ID,
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "radial", parameter, center: [0, 0, 0], axis: axis as [number, number, number], parameterMeaning: "diameter", presentation: "diameter" }
  };
}

const numberSchema: ParamSchema = { title: "t", parameters: [{ name: "wallThickness", type: "number", initial: 5 }] };
const withStringParam: ParamSchema = { title: "t", parameters: [{ name: "wallThickness", type: "number", initial: 5 }, { name: "label", type: "string", initial: "x" }] };

describe("editorEligibility", () => {
  it("marks a linear binding requires-proof when its parameter is numeric and present", () => {
    const [entry] = editorEligibility([linearFeature("f1", "wallThickness")], numberSchema);
    expect(entry).toEqual({ featureId: "f1", state: "requires-proof", reason: null });
  });

  it("marks unsupported when the parameter is missing from the schema", () => {
    const [entry] = editorEligibility([linearFeature("f1", "doesNotExist")], numberSchema);
    expect(entry.state).toBe("unsupported");
    expect(entry.reason).toMatch(/not in the current parameter schema/);
  });

  it("marks unsupported when the parameter is non-numeric", () => {
    const [entry] = editorEligibility([linearFeature("f1", "label")], withStringParam);
    expect(entry.state).toBe("unsupported");
    expect(entry.reason).toMatch(/not numeric/);
  });

  it("marks a radial binding requires-proof when its axis is principal", () => {
    const [entry] = editorEligibility([radialFeature("f1", "wallThickness", [0, 0, 1])], numberSchema);
    expect(entry).toEqual({ featureId: "f1", state: "requires-proof", reason: null });
  });

  it("marks a radial binding unsupported when its axis is not a principal axis", () => {
    const diagonal = 1 / Math.sqrt(3);
    const [entry] = editorEligibility([radialFeature("f1", "wallThickness", [diagonal, diagonal, diagonal])], numberSchema);
    expect(entry.state).toBe("unsupported");
    expect(entry.reason).toMatch(/not aligned with a principal axis/);
  });

  it("returns one entry per feature, in input order, regardless of eligibility", () => {
    const features = [linearFeature("f1", "wallThickness"), linearFeature("f2", "missing"), radialFeature("f3", "wallThickness", [1, 0, 0])];
    const result = editorEligibility(features, numberSchema);
    expect(result.map((e) => e.featureId)).toEqual(["f1", "f2", "f3"]);
    expect(result.map((e) => e.state)).toEqual(["requires-proof", "unsupported", "requires-proof"]);
  });

  it("is pure: an empty feature list returns an empty array", () => {
    expect(editorEligibility([], numberSchema)).toEqual([]);
  });
});
