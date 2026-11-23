// @scadforge/scad-core — minimal Vec3/Axis primitives for the geometry module
// (Issue #91, S3-B ticket B5).
//
// The ported S2 recognizer (`cylinderFit.ts`, `refusals.ts`,
// `inspectionTypes.ts`, `regionGrowth.ts`) originally depended on
// `apps/web/src/components/measure.ts`'s `Axis`/`Vec3`/`formatMm`, which is
// not part of this port (it also carries measurement-overlay/bbox helpers
// this package has no use for) and which this GPL-free, browser-safe package
// must not import from `apps/web` regardless. This file declares the exact
// same shapes so the ported math is structurally identical to its origin —
// TypeScript's structural typing means callers on both sides (this package's
// probe, and `apps/web`'s re-export shims) interoperate without conversion.
//
// SPDX-License-Identifier: Apache-2.0

export type Axis = "x" | "y" | "z";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Integer millimetres print bare ("105"); fractions keep one decimal ("12.5"). Verbatim from `apps/web/src/components/measure.ts`. */
export function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}
