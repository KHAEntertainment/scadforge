// SPDX-License-Identifier: Apache-2.0

// S3-C C4 — the only value math typed entry needs (Issue #136, Tech-Lead
// condition 6). An editor `set-value` command always carries the PARAMETER
// value; what the user reads and types is the feature's presentation value.
//
//  - Radial: the binding declares what the parameter means (`radius` or
//    `diameter`) and what the user is shown (`presentation`). Equal fields
//    mean no conversion. The radius/diameter factor mirrors
//    `packages/scad-core/src/editor/proof.ts` (`expectedDiameterMm`), which
//    keeps it inline and unexported.
//  - Linear: the mapping's `scale`/`offset`/`anchor` place the parameter on
//    a geometric axis (the proof and the S4 handle use them); they do not
//    change the number being edited, so the presentation value is the
//    parameter value.

import type { Binding, EditorDocument, EditorFeature } from "@scadforge/protocol";

/** A diameter is this many radii. */
const DIAMETER_PER_RADIUS = 2;

export function presentationUnit(binding: Binding): "radius" | "diameter" | null {
  return binding.kind === "radial" ? binding.presentation : null;
}

/** Parameter value → the number the user sees. */
export function toPresentationValue(binding: Binding, parameterValue: number): number {
  if (binding.kind !== "radial" || binding.parameterMeaning === binding.presentation) return parameterValue;
  return binding.presentation === "diameter" ? parameterValue * DIAMETER_PER_RADIUS : parameterValue / DIAMETER_PER_RADIUS;
}

/** The number the user typed → the parameter value the command carries. */
export function toParameterValue(binding: Binding, presentationValue: number): number {
  if (binding.kind !== "radial" || binding.parameterMeaning === binding.presentation) return presentationValue;
  return binding.presentation === "diameter" ? presentationValue / DIAMETER_PER_RADIUS : presentationValue * DIAMETER_PER_RADIUS;
}

/** The feature's current parameter value in `document`, or `null` when it is not a finite number. */
export function currentParameterValue(document: EditorDocument, feature: EditorFeature): number | null {
  const value = document.values[feature.binding.parameter];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parses typed text. Empty or whitespace-only text is NaN (not `Number("")`'s
 * 0), so `propose()`'s `non-finite-candidate` refusal is what reports it.
 */
export function parseTypedValue(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? Number.NaN : Number(trimmed);
}
