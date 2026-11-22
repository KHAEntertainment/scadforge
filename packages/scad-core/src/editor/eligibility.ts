// @scadforge/scad-core — editor eligibility (Issue #91, S3-B ticket B5).
//
// The exact signature is the eligibility seam frozen in the S3-B ticket
// story ("Eligibility seam (owned by B5, consumed by B7 through a
// stand-in)"): B7's `read_project` agent-context block reports this for
// every feature, and B6's `GET …/editor` document does the same. Proofs
// (`proof.ts`) never persist as eligibility — this is a pure, synchronous
// read-time classification: "would a proof for this feature's exact current
// binding even be worth attempting", not "has a proof been obtained".
//
// SPDX-License-Identifier: Apache-2.0

import type { Binding, EditorEligibility, EditorFeature } from "@scadforge/protocol";
import type { ParamSchema } from "../types.js";
import { principalAxisOf } from "../geometry/regionGrowth.js";
import type { Vec3 } from "../geometry/vec.js";

function toVec3(tuple: readonly [number, number, number]): Vec3 {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

/**
 * `null` when `binding` is eligible for a proof attempt; otherwise the
 * unsupported reason. A parameter missing from the schema or non-numeric
 * makes ANY binding kind unsupported; a non-principal axis is additionally
 * checked for radial bindings only (S1 contract design: restricted linear
 * and radial mapping — only x/y/z-aligned cylinders are currently
 * recognized).
 *
 * Exported (not just `editorEligibility` below) because `proof.ts` runs
 * this SAME check as its first degenerate-case gate before attempting a
 * render — the ticket's "a parameter absent from the schema or
 * non-numeric, an unsupported principal axis for a radial binding" probe
 * refusal is exactly this eligibility check, run once more at proof time
 * rather than re-implemented.
 */
export function checkBindingEligibility(binding: Binding, schema: ParamSchema): string | null {
  const param = schema.parameters.find((candidate) => candidate.name === binding.parameter);
  if (!param) {
    return `Parameter "${binding.parameter}" is not in the current parameter schema.`;
  }
  if (param.type !== "number") {
    return `Parameter "${binding.parameter}" is not numeric.`;
  }
  if (binding.kind === "radial" && principalAxisOf(toVec3(binding.axis)) === null) {
    return "The radial binding's axis is not aligned with a principal axis (x, y or z).";
  }
  return null;
}

/**
 * One entry per feature, in the same order as `features` (featureId order,
 * per the wire's `EditorSidecar`). Pure; no I/O — `schema` and `features`
 * are supplied by the caller's own coherent read.
 */
export function editorEligibility(features: readonly EditorFeature[], schema: ParamSchema): EditorEligibility[] {
  return features.map((feature) => {
    const reason = checkBindingEligibility(feature.binding, schema);
    return reason === null
      ? { featureId: feature.featureId, state: "requires-proof", reason: null }
      : { featureId: feature.featureId, state: "unsupported", reason };
  });
}
