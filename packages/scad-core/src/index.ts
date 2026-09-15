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

// Line-ending normalization (Issue #40) — the write-time fix applied wherever
// scad-core persists/ingests `.scad` source.
export { normalizeLineEndings } from "./lf.js";

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
export { exportRun, exportRunWithValidation } from "./runner/export.js";
export type { ExportRunWithValidationResult } from "./runner/export.js";
export { validateModel } from "./runner/validate-model.js";
export type { ValidateModelOptions } from "./runner/validate-model.js";
export { validateParamValues } from "./runner/params-validate.js";
export type { ParamRejection, ParamRejectionReason, ValidateParamValuesResult } from "./runner/params-validate.js";
export { analyzeSourceParams } from "./runner/source-params.js";
export type { SourceParamsAnalysis } from "./runner/source-params.js";

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
  createSnapshotLocked,
  initProject,
  listSnapshots,
  listSnapshotsLocked,
  mergeParamsAtomic,
  readProjectManifest,
  readProjectManifestLocked,
  readSnapshotManifest,
  readSnapshotManifestLocked,
  recordExport,
  revertToSnapshot,
  revertToSnapshotLocked,
  updateRootParamsLocked
} from "./store/store.js";
export type { CreateSnapshotInput, InitProjectInput, RevertToSnapshotOptions } from "./store/store.js";
export { PARAMS_LOCK_MAX_ATTEMPTS, withParamsLock } from "./store/params-lock.js";
export { computeSourceRevision } from "./store/revision.js";
export {
  attachRendersToSnapshotLocked,
  attachValidationToSnapshotLocked,
  resolveSnapshotMeshPath,
  resolveSnapshotRenderPath,
  resolveSnapshotValidationPath,
  SNAPSHOT_MESH_FILE,
  snapshotMeshPath,
  snapshotRenderPath,
  snapshotValidationPath,
  snapshotViewsDir
} from "./store/attachments.js";
export type { AttachRendersOptions, RenderAttachment } from "./store/attachments.js";

// editor/
//
// Canonical identity for the S3 studio editor (Issue #72, S3-B B1): canonical
// JSON, domain-prefixed SHA-256 digests, the sidecar digest, editor revision,
// and command/request digests. This is the shared seam later S3-B tickets
// (B3 sidecar storage, B4 staged transactions, B5 proof service) hash
// against — see the S3-B ticket story's "Shared seams" block.
export {
  canonicalJson,
  canonicalSidecar,
  commandDigest,
  digest,
  editorRevision,
  requestDigest,
  sidecarDigest
} from "./editor/canonical.js";
export type { DigestDomain } from "./editor/canonical.js";

// ── recovery boundary (Issue #73 / S3-B ticket B2) ──────────────────────────
//
// Kept as its own block, separate from B1's own additions below/above, so a
// concurrent merge of both tickets' export lists stays a trivial textual
// merge (see the S3-B ticket story's "Shared seams" note).
export { withRecoveredProject } from "./store/recovered.js";
export type { LockedProject, ReadResult } from "./store/recovered.js";
export { FILE_LOCK_MAX_ATTEMPTS, LOCK_OWNER_FILE, STALE_LOCK_MIN_AGE_MS, withFileLock } from "./store/file-lock.js";

// ── sidecar storage (Issue #87 / S3-B ticket B3) ────────────────────────────
//
// Kept as its own block for the same merge-friendliness reason as B1/B2
// above. `writeSidecarBytesLocked`, `captureSidecarForSnapshotLocked` and the
// sidecar path helpers stay package-internal (store.ts imports them via a
// relative path) -- nothing outside this package needs them yet.
export {
  EMPTY_SIDECAR,
  quarantine,
  readSidecarLocked,
  readSnapshotSidecarLocked,
  serializeCanonicalSidecar,
  writeSidecarLocked
} from "./editor/sidecar.js";
export type { SidecarReadResult } from "./editor/sidecar.js";

// ── source fingerprint (Issue #92 / S3-B ticket B7) ─────────────────────────
//
// Kept as its own block for the same merge-friendliness reason as B1/B2/B3
// above. The ONE shared implementation B5's proof records and B6's editor
// document consume alongside B7's agent context -- see canonical.ts's
// `sourceFingerprint` doc comment.
export { sourceFingerprint } from "./editor/canonical.js";

// ── staged roll-forward transactions and durable operation claims
// (Issue #90 / S3-B ticket B4) ──────────────────────────────────────────────
//
// Kept as its OWN block, separate from B5's (which adds a parallel export
// block to this same file — see the S3-B ticket story's "Shared seams"
// note), so a concurrent merge of both tickets' export lists stays a
// trivial textual merge. `stageTransactionLocked`/`decideLocked`/
// `publishLocked`/`reconcileTransactionLocked` are consumed by `store.ts`
// and `editor/sidecar.ts` internally via relative imports; exported here so
// B6 (editor commands) and B8 (fault qualification) can drive the same
// mechanism without reaching into `store/` by a relative path.
//
// `faultPoint`: production-safe to call unconditionally -- it is a no-op
// unless `SCADFORGE_FAULT_POINT` names the exact boundary, so B6's real
// `submitEditorCommand` path (apps/server) calls it directly rather than
// through a test-only seam (Issue #111).
//
// `__setFaultActionForTests`: TEST-ONLY. Swaps the armed fault point's
// action (default: self-`SIGKILL`, which B8's separate-process crash matrix
// relies on) for a throwing stand-in, so an IN-PROCESS test in a consuming
// package (e.g. apps/server's `scad-core-impl.test.ts`) can observe the
// "after-claim" boundary firing on the real path without killing the test
// runner. Arming stays env-var-only (`SCADFORGE_FAULT_POINT`) regardless --
// this only changes what happens once armed, and only a test that explicitly
// imports and calls it is ever affected.
export {
  abortTransactionLocked,
  decideLocked,
  faultPoint,
  publishLocked,
  reconcileTransactionLocked,
  recoverPendingClaimsLocked,
  recoverTransactionsLocked,
  stageTransactionLocked,
  __setFaultActionForTests
} from "./store/transaction.js";
export type {
  CommitDecision,
  DecidedTransaction,
  FaultPointName,
  StagedTransaction,
  TransactionClaimLink,
  TransactionIntent,
  TransactionRootFiles,
  TransactionSnapshotFiles
} from "./store/transaction.js";
export {
  ABORTED_REPLAY_MESSAGE,
  decideReplay,
  lookupClaimLocked,
  recordClaimAbortedLocked,
  recordClaimCommittedLocked,
  recordClaimRejectedLocked,
  reserveClaimLocked
} from "./store/claims.js";
export type {
  AcceptedOperationRecord,
  ClaimLookupResult,
  ClaimTerminalState,
  OperationClaim,
  ReplayDecision,
  ReserveClaimResult
} from "./store/claims.js";

// ── proof service and eligibility (Issue #91 / S3-B ticket B5) ─────────────
//
// Kept as its own block for the same merge-friendliness reason as B1/B2/B3
// above. The recognizer port itself (`geometry/**`) is NOT re-exported here
// deliberately — it is reached ONLY through the separate browser-safe
// `./geometry` package-export subpath (see `package.json` and
// `src/geometry/index.ts`'s header), never through this root barrel.
export { editorEligibility, checkBindingEligibility } from "./editor/eligibility.js";
export {
  PROOF_TTL_MS,
  RECOGNIZER_VERSION,
  lookupProofLocked,
  persistProofRecord,
  runProbe
} from "./editor/proof.js";
export type {
  ProofLookupResult,
  ProofRecord,
  ProofRenderDeps,
  ProofSample,
  ProbeResult,
  RunProbeInput
} from "./editor/proof.js";

// ── editor command application (Issue #98 / S3-B ticket B6) ────────────────
//
// Kept as its own block for the same merge-friendliness reason as B1/B2/B3/B5
// above. Pure, I/O-free — `apps/server/src/services/scad-core-impl.ts` is the
// only caller, composing this with B4's stage/decide/publish and B5's
// `lookupProofLocked` under one `withRecoveredProject` boundary entry.
export { applyEditorCommand, applyEditorTraversal } from "./editor/commands.js";
export type {
  ApplyEditorCommandInput,
  ApplyEditorTraversalInput,
  EditorCommandAccepted,
  EditorCommandRefusal,
  EditorCommandResult
} from "./editor/commands.js";
