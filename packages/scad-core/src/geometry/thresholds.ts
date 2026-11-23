// @scadforge/scad-core — S2 surface-recognition thresholds, ported verbatim
// from apps/web/src/components/inspect/thresholds.ts (Issue #91, S3-B ticket
// B5; owner decision: port the pure S2 recognizer into scad-core, web
// re-imports it — see the S3-B ticket story's "Shared seams").
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Starting thresholds for cylindrical surface recognition (S2 scope,
 * "Starting thresholds" table). Every threshold used anywhere under
 * `geometry/` lives here — no threshold constant is defined anywhere
 * else in this slice.
 *
 * These are starting values calibrated on the S2 fixtures. If a test seems
 * to need a different value, that is a signal to bring back for review, not
 * to retune silently (S2 scope, Risks §1).
 */
export const INSPECTION_THRESHOLDS = {
  /** Normal perpendicular to axis: component along the axis must be ≤ this to admit the surface. Tolerates float32 STL noise, rejects cones and tilts. */
  maxAxialNormalComponent: 0.02,
  /** Neighbor facet angular step (degrees) admitted during region growth. Admits 12+ segments; stops at 90° cube edges. */
  maxFacetStepDeg: 31,
  /** Minimum full-circle-equivalent segment count. Below this a coarse polygon (e.g. a hex boss) must not be reported as a cylinder. */
  minSegments: 12,
  /** Minimum arc coverage (degrees) to confirm a cylindrical feature; partial arcs below this are deferred (D5). */
  minArcDegrees: 180,
  /** Maximum circle-fit deviation (mm) before facets are judged not circular. Catches ellipses and tangent flats (slots). */
  maxDeviationMm: 0.01,
  /**
   * Coordinator-added (S2-2 fixup 1). Angular step admitted while
   * probing a flat 31°-region for a coarser regular polygon (a hex
   * boss, an octagon), tried only after the normal growth threshold
   * already found the region flat. Admits 5+ sided regular polygons
   * (up to 72°); excludes 90° box corners.
   */
  coarseProbeMaxStepDeg: 75,
  /**
   * Coordinator-added (S2-2 fixup 1). How close every vertex-to-vertex
   * angular step in a coarse-polygon probe region must be to the median
   * step to call it a regular polygon rather than an irregular shape
   * (e.g. a chamfered box corner's alternating long/short steps).
   */
  coarseProbeStepToleranceDeg: 1,
  /**
   * S2-4. A pointer whose travel between down and up is at most this
   * many pixels (r3f's `event.delta`) counts as a click, not a drag --
   * so orbiting the camera never selects a surface. Web-only concern, kept
   * for parity with the origin file; unused server-side.
   */
  clickMaxDeltaPx: 4
} as const;

export type InspectionThresholds = typeof INSPECTION_THRESHOLDS;

/**
 * Starting thresholds for `../editor/proof.ts`'s linear/radial probe checks
 * (Issue #91, S3-B ticket B5 review A1/A2: "thresholds live in one file" —
 * moved here from `proof.ts` so no threshold constant used anywhere under
 * this package lives outside this module). Distinct from
 * `INSPECTION_THRESHOLDS` above, which governs RECOGNITION itself (does a
 * region fit a circle at all); these govern the probe's own comparison of a
 * rendered measurement against the binding's DECLARED relation, once a
 * region has already been recognized.
 *
 * All three are `INSPECTION_THRESHOLDS.maxDeviationMm` (0.01 mm — the S2
 * single-sample circle-fit precision, used unchanged and directly by
 * `radialMatch.ts`'s own per-sample radial-position and diameter-match
 * criteria) widened ×5, not a separately invented precision tier — each
 * measures something coarser than one circle fit:
 *   - `linearExtentToleranceMm`/`linearAnchorToleranceMm` compare a bounding
 *     -box EXTREME-VERTEX measurement (two data points: the mesh's min and
 *     max along an axis) against an analytically-computed expected value,
 *     not a many-point circle-fit residual.
 *   - `radialIdentityAxialToleranceMm` compares a region's fitted axial
 *     CENTER (itself derived from a min/max range, like the linear
 *     measurements) across TWO INDEPENDENT renders (cross-sample region
 *     identity — module header's match-criteria ruling in `proof.ts`), not
 *     within one.
 * A genuinely unchanged measurement is numerically near-identical run to
 * run; the ×5 widening absorbs these compounded effects, not real movement
 * — see `proof.docker.test.ts`'s calibration assertions, which measure the
 * actual drift on real fixtures and require it stay well under this bound.
 */
export const PROOF_THRESHOLDS = {
  /** Max |rendered extent − (scale·param + offset)| in mm before a linear check refuses. */
  linearExtentToleranceMm: 0.05,
  /** Max drift in the anchored face's absolute position (mm) across samples before a linear check refuses. */
  linearAnchorToleranceMm: 0.05,
  /** Max drift (mm) in a matched region's axial center position across samples before it is treated as a DIFFERENT region for the cross-sample identity comparison. */
  radialIdentityAxialToleranceMm: 0.05
} as const;
