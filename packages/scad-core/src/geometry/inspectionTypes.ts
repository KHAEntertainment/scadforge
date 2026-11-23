// @scadforge/scad-core — shared S2 inspection types, ported verbatim from
// apps/web/src/components/inspect/inspectionTypes.ts (Issue #91, S3-B ticket
// B5).
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared inspection types (S2 shared interface, owned by ticket S2-1).
 *
 * This is the seam the whole S2 surface-inspection slice, and now B5's
 * radial proof check, are built against. Changing the shape here means
 * updating the S2 tickets story and the S3-B ticket story first.
 *
 * Uses this module's own `Axis`/`Vec3` (`./vec.js`) rather than
 * `apps/web/src/components/measure.ts`'s — see `vec.ts`'s header for why.
 */

import type { Axis, Vec3 } from "./vec.js";

/** The geometric evidence a recognized cylinder was measured from. */
export interface CylinderEvidence {
  /** Full-circle equivalent: 360° ÷ median angular step between adjacent vertices. */
  segments: number;
  /** 360 if the largest angular gap ≤ 1.5 × median step (closed ring), else 360 − largest gap. */
  arcDegrees: number;
  /** max | |p − c| − r | over region vertices, in mm. */
  maxDeviationMm: number;
  /** Region extent along the axis, in mm. */
  axialLengthMm: number;
}

/**
 * Shaped to the S1 `radial` MeasurableCapability. Transient: no
 * `featureId`, never persisted (S2 produces tier-1 transient results
 * only — see the S2 scope's "What S2 produces, in contract terms").
 */
export interface CylinderInspection {
  kind: "radial";
  surface: "hole" | "outside";
  axis: Axis;
  /** On the axis, at the region's axial midpoint. */
  center: Vec3;
  diameterMm: number;
  evidence: CylinderEvidence;
}

export type RefusalCode = "planar" | "not-axis-aligned" | "too-coarse" | "partial-arc" | "not-circular";

/** `message` is rendered verbatim, as plain text (D6: fail closed, no markup). */
export interface Refusal {
  code: RefusalCode;
  message: string;
}

export type InspectionOutcome =
  | { status: "recognized"; inspection: CylinderInspection; regionTriangles: Uint32Array }
  | { status: "refused"; refusal: Refusal };
