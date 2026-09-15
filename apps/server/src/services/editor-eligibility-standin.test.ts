// SPDX-License-Identifier: GPL-3.0-or-later
//
// Issue #92 (S3-B ticket B7): the STAND-IN (B5) eligibility function must
// report exactly `{ featureId, state: "requires-proof", reason: null }` for
// every feature, in input order, regardless of schema content — see the
// production file's header for why over-reporting `requires-proof` is the
// safe direction for a referenceability-only block.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EditorFeature } from "@scadforge/protocol";
import type { ParamSchema } from "@scadforge/scad-core";
import { editorEligibility } from "./editor-eligibility-standin.js";

const EMPTY_SCHEMA: ParamSchema = { title: "", parameters: [] };

function feature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: randomUUID(),
    label: "Width",
    projectId: randomUUID(),
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "width", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
    ...overrides
  };
}

describe("editorEligibility (STAND-IN for B5, Issue #92)", () => {
  it("returns an empty array for an empty feature list", () => {
    expect(editorEligibility([], EMPTY_SCHEMA)).toEqual([]);
  });

  it("reports requires-proof with a null reason for every feature", () => {
    const features = [feature(), feature(), feature()];

    const result = editorEligibility(features, EMPTY_SCHEMA);

    expect(result).toEqual(
      features.map((f) => ({ featureId: f.featureId, state: "requires-proof", reason: null }))
    );
  });

  it("preserves input order (does not re-sort)", () => {
    const a = feature({ featureId: "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz" });
    const b = feature({ featureId: "11111111-1111-4111-8111-111111111111" });

    const result = editorEligibility([a, b], EMPTY_SCHEMA);

    expect(result.map((r) => r.featureId)).toEqual([a.featureId, b.featureId]);
  });

  it("is unaffected by schema content, including a radial-binding feature with no matching schema parameter", () => {
    const radial = feature({
      binding: {
        kind: "radial",
        parameter: "radius",
        center: [0, 0, 0],
        axis: [0, 0, 1],
        parameterMeaning: "radius",
        presentation: "radius"
      }
    });

    const result = editorEligibility([radial], EMPTY_SCHEMA);

    expect(result).toEqual([{ featureId: radial.featureId, state: "requires-proof", reason: null }]);
  });
});
