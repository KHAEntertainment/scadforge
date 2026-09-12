/**
 * Starting thresholds for cylindrical surface recognition (S2 scope,
 * "Starting thresholds" table). Every threshold used anywhere under
 * `inspect/` lives here — no threshold constant is defined anywhere
 * else in this slice.
 *
 * These are starting values to calibrate on the fixtures (ticket 3).
 * If a test seems to need a different value, that is a signal to bring
 * back for review, not to retune silently (S2 scope, Risks §1).
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
  maxDeviationMm: 0.01
} as const;

export type InspectionThresholds = typeof INSPECTION_THRESHOLDS;
