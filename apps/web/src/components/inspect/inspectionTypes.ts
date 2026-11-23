// Re-export shim (S3-B B5, Issue #91): the S2 shared inspection types now
// live in `@scadforge/scad-core/geometry`. See `thresholds.ts`'s header for
// why this imports the `./geometry` subpath, never the package root.
//
// `CylinderInspection`'s `axis`/`center` fields use scad-core's own local
// `Axis`/`Vec3` (`@scadforge/scad-core/geometry`'s `vec.ts`), structurally
// identical to this app's `../measure.js` shapes — TypeScript's structural
// typing means every existing consumer here (`InspectReadout.tsx`,
// `SurfaceHighlight.tsx`, `highlightGeometry.ts`, `PreviewTab.tsx`) keeps
// working unchanged.

export type { CylinderEvidence, CylinderInspection, RefusalCode, Refusal, InspectionOutcome } from "@scadforge/scad-core/geometry";
