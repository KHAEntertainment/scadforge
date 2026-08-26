// @scadforge/scad-core — package entry point.
//
// This package owns the OpenSCAD project model. `src/types.ts` is the FROZEN
// contract (Issue #13, Tech-Lead-owned — see its header); the runtime lives in
// params/ (Customizer parameter parsing), store/ (filesystem `.scadforge/`
// project store), validate/ (mesh validation) and runner/ (OpenSCAD CLI
// subprocess runner) — implemented for Issue #14.
//
// SPDX-License-Identifier: Apache-2.0

export const SCAD_CORE_PACKAGE_NAME = "@scadforge/scad-core";

export * from "./types.js";
export * from "./errors.js";

// runner/
export {
  filterOpenscadDiagnostics,
  OPENSCAD_IMAGE_ENV_VAR,
  resolveOpenscadImage,
  runOpenscad
} from "./runner/docker.js";
export type { RunOpenscadOptions, RunOpenscadResult } from "./runner/docker.js";
export { stageWork } from "./runner/workdir.js";
export type { StagedWork, StageWorkOptions } from "./runner/workdir.js";
export { RENDER_OVERRIDE_PARAMS_FILE, writeOverrideParamsFile } from "./runner/params-file.js";
export { renderViews, readRenderedPng } from "./runner/render.js";
export { runSyntaxCheck } from "./runner/syntax.js";
export { runParamExport } from "./runner/param-export.js";
export { exportMeshWithValidationStl } from "./runner/mesh-export.js";
export type { MeshExportResult } from "./runner/mesh-export.js";
export { exportRun } from "./runner/export.js";

// validate/
export { parseStl } from "./validate/stl.js";
export type { Triangle, Vertex } from "./validate/stl.js";
export { WELD_EPSILON_MM, weldTriangleSoup } from "./validate/mesh-utils.js";
export type { WeldedMesh } from "./validate/mesh-utils.js";
export { gateValidation } from "./validate/gate.js";
export { validateMesh } from "./validate/validate.js";

// store/
export {
  formatSnapshotId,
  nextSnapshotId,
  parseSnapshotId
} from "./store/paths.js";
export {
  createSnapshot,
  initProject,
  listSnapshots,
  readProjectManifest,
  readSnapshotManifest,
  recordExport,
  revertToSnapshot
} from "./store/store.js";
export type { CreateSnapshotInput, InitProjectInput } from "./store/store.js";
