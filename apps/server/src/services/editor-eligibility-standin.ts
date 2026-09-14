// SPDX-License-Identifier: Apache-2.0
//
// STAND-IN (B5) — Issue #92, S3-B ticket B7.
//
// B7 (agent editor context) and B5 (proof service, real eligibility) start in
// parallel (owner decision, S3-B ticket story, 2026-09-14), so B7 builds
// against this stand-in for B5's `editorEligibility` function instead of
// waiting on it. The real implementation lands at
// `packages/scad-core/src/editor/eligibility.ts`, exported from
// `@scadforge/scad-core` — see the S3-B ticket story's "Eligibility seam"
// section for its exact signature and semantics.
//
// Every feature reports `requires-proof` regardless of its binding or the
// schema, in input order. This is deliberately the SAFE direction to
// over-report: the D7 block is referenceability only and grants no write
// authority on its own (every actual edit still needs a fresh server-side
// proof), so a feature the real B5 function would mark `unsupported` merely
// appearing as `requires-proof` here cannot enable an edit it shouldn't.
// Under-reporting `unsupported` would be the unsafe direction — it would
// hide a feature from the agent that the real function considers
// permanently ineligible — which is exactly why this stand-in never does it.
//
// Swap rule (S3-B ticket story): whichever of B5 and B7 merges SECOND does
// the swap, in its own PR: delete this file and its test, and point
// `agent-scad-core.ts`'s single import at `@scadforge/scad-core` instead.
// That swap is a declared deviation in that PR, not scope drift.

import type { EditorEligibility, EditorFeature } from "@scadforge/protocol";
import type { ParamSchema } from "@scadforge/scad-core";

/**
 * The stand-in eligibility function. Pure; no I/O — matches B5's real
 * signature exactly so the swap above is a one-line import change.
 *
 * @param features The project's editor features, in the order the caller
 *   supplies them (B7's caller already sorts by `featureId` via the sidecar's
 *   own canonical form; this function does not re-sort).
 * @param schema The current Customizer parameter schema. Unused by the
 *   stand-in — accepted only to match B5's real signature.
 */
export function editorEligibility(
  features: readonly EditorFeature[],
  schema: ParamSchema
): EditorEligibility[] {
  void schema; // Unused by the stand-in; kept to match B5's real signature exactly.
  return features.map((feature) => ({
    featureId: feature.featureId,
    state: "requires-proof",
    reason: null
  }));
}
