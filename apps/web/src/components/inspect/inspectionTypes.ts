/**
 * Shared inspection types (S2 shared interface, owned by ticket S2-1).
 *
 * This is the seam the whole S2 surface-inspection slice is built
 * against: ticket 2 (surface region + `inspectSurface`), ticket 4
 * (viewer picking) and ticket 5 (toolbar + readout) all consume these
 * types unchanged. Changing the shape here means updating the S2
 * tickets story first — see
 * `epics/.../s2-surface-inspection-scope/tickets/index.md`.
 *
 * Reuses `Axis` and `Vec3` from `measure.ts` rather than redefining an
 * axis/vector type here.
 */

import type { Axis, Vec3 } from "../measure.js";

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
