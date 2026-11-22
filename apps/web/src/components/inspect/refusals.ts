// Re-export shim (S3-B B5, Issue #91): the S2 refusal catalogue now lives
// in `@scadforge/scad-core/geometry`. See `thresholds.ts`'s header for why
// this imports the `./geometry` subpath, never the package root.

export { planarRefusal, notAxisAlignedRefusal, tooCoarseRefusal, partialArcRefusal, notCircularRefusal } from "@scadforge/scad-core/geometry";
