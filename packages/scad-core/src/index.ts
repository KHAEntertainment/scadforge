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

// params/
export {
  CRLF_ANNOTATION_WARNING,
  DEFAULT_PARAM_GROUP,
  parseParamSchema,
  parseParamSchemaWithDiagnostics,
  sourceHasCrlf
} from "./params/index.js";
export type { ParseParamSchemaOptions, ParseParamSchemaWithDiagnosticsResult } from "./params/index.js";

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
export { validateModel } from "./runner/validate-model.js";
export type { ValidateModelOptions } from "./runner/validate-model.js";
export { validateParamValues } from "./runner/params-validate.js";
export type { ParamRejection, ParamRejectionReason, ValidateParamValuesResult } from "./runner/params-validate.js";

// validate/
export { parseStl } from "./validate/stl.js";
export type { Triangle, Vertex } from "./validate/stl.js";
export { WELD_EPSILON_MM, weldTriangleSoup } from "./validate/mesh-utils.js";
export type { WeldedMesh } from "./validate/mesh-utils.js";
export { gateValidation } from "./validate/gate.js";
export { validateMesh } from "./validate/validate.js";

// store/
//
// The path helpers are exported (Issue #20 glue) because `apps/server` has to
// serve files straight out of the store — a snapshot's PNG, an export
// artifact, the root `model.scad` — and hand absolute paths to the OpenSCAD
// runner. Without them every consumer would re-derive `PROJECT_LAYOUT` joins
// by hand, which is how an on-disk layout quietly forks.
export {
  exportsDir,
  formatSnapshotId,
  historyDir,
  metaDir,
  nextSnapshotId,
  parseSnapshotId,
  projectFilePath,
  rootModelPath,
  rootParamsPath,
  snapshotDir
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
export {
  attachRendersToSnapshot,
  attachValidationToSnapshot,
  snapshotRenderPath,
  snapshotValidationPath,
  snapshotViewsDir
} from "./store/attachments.js";
export type { AttachRendersOptions, RenderAttachment } from "./store/attachments.js";
