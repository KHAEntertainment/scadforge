// Re-export shim (S3-B B5, Issue #91): the S2 recognizer thresholds now
// live in `@scadforge/scad-core/geometry` (port decision recorded in the
// S3-B ticket story's "Shared seams" — one recognizer for Inspect and for
// B5's proofs). Imports from the `./geometry` package export specifically,
// never the package root, which pulls in the Docker runner and Node
// builtins unsafe for this browser bundle (see that package's
// `package.json` "exports" and `src/geometry/index.ts`).

export { INSPECTION_THRESHOLDS } from "@scadforge/scad-core/geometry";
export type { InspectionThresholds } from "@scadforge/scad-core/geometry";
