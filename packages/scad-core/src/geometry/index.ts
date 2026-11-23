// @scadforge/scad-core/geometry — browser-safe entry point (Issue #91, S3-B
// ticket B5).
//
// This is the `./geometry` package-export subpath declared in
// `package.json`, separate from the package root ("."). The root barrel
// (`src/index.ts`) pulls in the Docker OpenSCAD runner, `node:child_process`
// and `node:fs` — none of that may reach a browser bundle. Every module this
// file re-exports from, transitively, must import nothing from `node:*`,
// `../runner/**`, `../store/**` or any `../validate/**` module that touches
// the filesystem. `apps/web`'s re-export shims
// (`apps/web/src/components/inspect/{cylinderFit,thresholds,refusals,
// inspectionTypes}.ts`) import ONLY from here, never from the package root.
//
// `topology.ts` (STL-triVerts → WeldedMesh) and `radialMatch.ts` (declared-
// binding whole-mesh scan) are deliberately NOT re-exported here: they exist
// for this package's own server-side proof service
// (`../editor/proof.ts`), which imports them directly by relative path.
// `apps/web` builds its own `WeldedMesh` from three.js and has no use for
// either — keeping them out of this barrel keeps the browser-safe surface
// minimal on purpose, not because either module is unsafe to bundle (they
// aren't: see their own headers).
//
// SPDX-License-Identifier: Apache-2.0

export type { Axis, Vec3 } from "./vec.js";
export { formatMm } from "./vec.js";

export { INSPECTION_THRESHOLDS } from "./thresholds.js";
export type { InspectionThresholds } from "./thresholds.js";

export type { CylinderEvidence, CylinderInspection, RefusalCode, Refusal, InspectionOutcome } from "./inspectionTypes.js";

export { planarRefusal, notAxisAlignedRefusal, tooCoarseRefusal, partialArcRefusal, notCircularRefusal } from "./refusals.js";

export { fitCircleInPlane, angularStepsDeg, angularCoverage, classifySurface, sagittaMm, evaluateCylinder } from "./cylinderFit.js";

export type { Triangle, WeldedMesh } from "./mesh.js";
export { sub, cross, length, normalize, dot, angleBetweenDeg, faceNormal, buildAdjacency } from "./mesh.js";

export type { AxisSelection } from "./regionGrowth.js";
export {
  selectAxis,
  growRegion,
  distinctNormalCount,
  normalSpreadDeg,
  regionVerticesAndNormals,
  coarsePolygonOrPlanar,
  recognizeRegion,
  principalAxisOf
} from "./regionGrowth.js";
