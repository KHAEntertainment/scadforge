/**
 * Refusal catalogue (S2 scope, D6: fail closed). Every message here is
 * the scope's text **verbatim** — only the `{n}`, `{deg}` and `{dev}`
 * placeholders are filled in, using `formatMm`-style formatting (reused
 * from `measure.ts`, not redefined here). Rendered as plain text next
 * to a disabled "Set up manually" CTA by later tickets.
 */

import { formatMm } from "../measure.js";
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

/** Fit deviation above the limit. `dev` is the maximum deviation in mm. */
export function notCircularRefusal(dev: number): Refusal {
  return { code: "not-circular", message: MESSAGES["not-circular"].replace("{dev}", formatMm(dev)) };
}
