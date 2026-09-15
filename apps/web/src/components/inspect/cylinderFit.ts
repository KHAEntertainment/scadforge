// Re-export shim (S3-B B5, Issue #91): the S2 cylinder-fit math now lives
// in `@scadforge/scad-core/geometry`. See `thresholds.ts`'s header for why
// this imports the `./geometry` subpath, never the package root.
//
// `surfaceRegion.ts` (the only caller) keeps importing from here rather
// than switching to the package directly, so the three.js bridge stays
// oblivious to where the math actually lives.

export { fitCircleInPlane, angularStepsDeg, angularCoverage, classifySurface, sagittaMm, evaluateCylinder } from "@scadforge/scad-core/geometry";
