// @scadforge/scad-core — S2 refusal catalogue, ported verbatim from
// apps/web/src/components/inspect/refusals.ts (Issue #91, S3-B ticket B5).
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Refusal catalogue (S2 scope, D6: fail closed). Every message here is
 * the scope's text **verbatim** — only the `{n}`, `{deg}` and `{dev}`
 * placeholders are filled in, using `formatMm`-style formatting (reused
 * from `./vec.js`, not redefined here). Rendered as plain text by the web
 * UI, and reused verbatim as the VALIDATION_FAILED refusal message by B5's
 * proof service.
 */

import { formatMm } from "./vec.js";
import type { Refusal } from "./inspectionTypes.js";

const MESSAGES = {
  planar: "This is a flat surface. Surface inspection measures cylindrical walls only.",
  "not-axis-aligned": "This surface isn't a cylinder aligned with the X, Y or Z axis.",
  "too-coarse": "This curve has only {n} segments — too few to tell a cylinder from a polygonal prism. Raise $fn for this feature to inspect it.",
  "partial-arc": "Only {deg}° of this curve is present — too little to confirm a cylindrical feature.",
  "not-circular": "These facets don't fit a single circle (off by up to {dev} mm), so no diameter is shown."
} as const;

/** Hit normal along an axis (a flat surface). No placeholders. */
export function planarRefusal(): Refusal {
  return { code: "planar", message: MESSAGES.planar };
}

/** Cones, tilted cylinders, spheres. No placeholders. */
export function notAxisAlignedRefusal(): Refusal {
  return { code: "not-axis-aligned", message: MESSAGES["not-axis-aligned"] };
}

/** Fewer than the minimum segment count. `n` is the full-circle-equivalent segment count. */
export function tooCoarseRefusal(n: number): Refusal {
  return { code: "too-coarse", message: MESSAGES["too-coarse"].replace("{n}", formatMm(n)) };
}

/** Arc coverage below the minimum. `deg` is the arc coverage in degrees. */
export function partialArcRefusal(deg: number): Refusal {
  return { code: "partial-arc", message: MESSAGES["partial-arc"].replace("{deg}", formatMm(deg)) };
}

/**
 * Deviation is near the 0.01 mm limit by construction (that's exactly
 * when this refusal fires), so `formatMm`'s one-decimal rounding would
 * print "0 mm" for a value just over the limit. Three decimals instead:
 * 0.0123 → "0.012".
 */
function formatDeviationMm(value: number): string {
  return value.toFixed(3);
}

/** Fit deviation above the limit. `dev` is the maximum deviation in mm. */
export function notCircularRefusal(dev: number): Refusal {
  return { code: "not-circular", message: MESSAGES["not-circular"].replace("{dev}", formatDeviationMm(dev)) };
}
