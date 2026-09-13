// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — ScadForge Issue #68 (S3-A).
//
// This file is Tech-Lead-owned once Issue #68 merges (CLAUDE.md hard rule 2 /
// PROJECT_CONTEXT.md "Contract freeze rule"). Do NOT edit it inside a feature
// PR. Changes require a Tech-Lead-approved contract-change issue, merged
// separately before any dependent work.
//
// SPDX-License-Identifier: Apache-2.0
// ─────────────────────────────────────────────────────────────────────────────
//
// S3-A editor protocol — the additive surface the studio editor needs to read
// and write parametric feature references.
//
// Canonical source: wire-and-recovery spec
// (`epics/.../s3-s4-plan/s3-contract/wire-and-recovery/`).
//
// Eight contract touchpoints land in Issue #68:
//   1. `packages/protocol/src/editor.ts` (THIS FILE) — types + parsers +
//      `EDITOR_SCHEMA_VERSION` (touchpoints 1, 3, 4 combined here).
//   2. `packages/protocol/src/index.ts` — barrel re-exports.
//   3. `EDITOR_ROUTES` (in this file).
//   4. `AgentEditorContext` (in this file).
//   5. `packages/agent/src/tools/contract.ts` — `agentEditorContextSchema`.
//   6. `packages/agent/src/tools/scad-core-api.ts` — `ProjectState.editor?`.
//   7. `packages/agent/src/tools/contract.ts` — `readProjectResultSchema.editor?`.
//   8. `packages/protocol/src/snapshot.ts` — disk manifest extensions
//      (`ProjectManifest.editor_store_version?`, `SnapshotManifest.editor?`).
//
// Existing imported types are `SnapshotId`, `ParamDefinitionWire`,
// `ParamValues`, `ApiError`.
//
// Parser rules (wire-and-recovery §"Exact additive protocol proposal"):
//   - Reject unknown versions and unknown fields.
//   - Reject wrong discriminants and duplicate feature IDs.
//   - Reject invalid IDs, invalid timestamps, non-finite numbers, malformed
//     hashes; never coerce strings into numbers.
//   - IDs are UUIDs; SHA-256 digests are lowercase 64-hex; `bindingVersion` is
//     a positive safe integer.
//   - Radial axes must be finite normalized Vec3 (norm within 1e-9 of one);
//     wire parsing preserves signed direction and does not normalize arbitrary
//     input.
//   - Labels: nonempty, at most 120 Unicode code points.
//   - Array length capped at 256 references; wire bodies at 1 MiB.
//   - No executable metadata.
// ─────────────────────────────────────────────────────────────────────────────

import { ERROR_CODES, type ApiError, type ScadForgeErrorCode } from "./errors.js";
import type { ParamDefinitionWire } from "./api.js";
import type { SnapshotId } from "./snapshot.js";
import type { ParamValues } from "./vocabulary.js";

// ═════════════════════════════════════════════════════════════════════════════
// 1. Schema version and route table
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The editor protocol schema version. Bumped only via a Tech-Lead-approved
 * contract-change issue. Readers must reject unknown majors.
 */
export const EDITOR_SCHEMA_VERSION = 1 as const;

/**
 * Route path templates for the editor transport, relative to
 * {@link API_BASE_PATH}. `EDITOR_ROUTES` is a separate constant — the
 * wire-and-recovery spec explicitly forbids silent mutation of the closed
 * `API_ROUTES` object. `:param` segments follow Hono's syntax.
 */
export const EDITOR_ROUTES = {
  get: "/projects/:projectId/editor",
  verify: "/projects/:projectId/editor/verify",
  commands: "/projects/:projectId/editor/commands",
  operation: "/projects/:projectId/editor/operations/:operationId"
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// 2. Numeric and shape limits
// ═════════════════════════════════════════════════════════════════════════════

/** Maximum number of Unicode code points a label may contain. */
export const EDITOR_LABEL_MAX_CODE_POINTS = 120;

/** Maximum number of references (features, eligibility entries) in one wire body. */
export const EDITOR_MAX_REFERENCE_ARRAY = 256;

/** Maximum byte length of one editor wire body (request or response). */
export const EDITOR_MAX_WIRE_BYTES = 1024 * 1024;

/** Tolerance for radial axis unit-vector normalization. */
export const EDITOR_RADIAL_AXIS_NORM_TOLERANCE = 1e-9;

/** Maximum safe integer bindingVersion may be. */
export const EDITOR_BINDING_VERSION_MAX = Number.MAX_SAFE_INTEGER;

// ═════════════════════════════════════════════════════════════════════════════
// 3. Vector and provenance types
// ═════════════════════════════════════════════════════════════════════════════

/** A 3-vector in mm. Wire shape: `[x, y, z]` triple of finite numbers. */
export type Vec3 = [number, number, number];

/**
 * How an `EditorFeature`'s binding was authored.
 *
 * - `manual`: typed by the user in the editor.
 * - `ai-proposed`: surfaced by the agent's `read_project` context.
 * - `parser-proposed`: surfaced by the OpenSCAD / project parsers.
 *
 * The two non-manual kinds require an explicit `confirmedBy: 'user'` — the
 * editor must never let an unconfirmed proposed binding participate in
 * authority (CLAUDE.md hard rule 5 and wire-and-recovery "referenceability").
 */
export type Provenance =
  | { kind: "manual" }
  | { kind: "ai-proposed" | "parser-proposed"; confirmedBy: "user" };

/**
 * The mapping from a Customizer parameter to a feature axis.
 *
 * Linear: maps `parameter` to a single principal axis via `scale * (v - offset)`
 * anchored at the named edge.
 * Radial: maps `parameter` to a radius/diameter around `center` along `axis`,
 * presented to the user as either a radius or a diameter number.
 *
 * The `scale` of 2 is meaningful: when the parameter represents a diameter but
 * the binding is linear in radius, `scale: 2, offset: 0` divides by two.
 */
export type Binding =
  | {
      kind: "linear";
      parameter: string;
      axis: "x" | "y" | "z";
      mapping: { scale: 1 | 2; offset: number; anchor: "min" | "max" | "center" };
    }
  | {
      kind: "radial";
      parameter: string;
      center: Vec3;
      /** Normalized finite Vec3. Wire parsing preserves signed direction. */
      axis: Vec3;
      parameterMeaning: "radius" | "diameter";
      presentation: "radius" | "diameter";
    };

// ═════════════════════════════════════════════════════════════════════════════
// 4. Editor document, sidecar, and feature shapes
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One editable feature reference. The project's authoritative namespace for
 * measurement and editable references — `featureId` is stable across edits and
 * is what later measurement work (S2 onward) attaches to.
 *
 * `createdAtRevision` MUST equal the editor revision that produced this
 * feature (server rejects mismatches). `bindingVersion` is bumped only on
 * binding replacement; binding creation starts at `1`.
 */
export interface EditorFeature {
  featureId: string;
  label: string;
  projectId: string;
  createdAtRevision: string;
  sourceFingerprint: string;
  bindingVersion: number;
  provenance: Provenance;
  binding: Binding;
}

/** The on-disk sidecar of editable references for one project. */
export interface EditorSidecar {
  /** Bump only via a contract-change issue; readers reject unknown majors. */
  version: 1;
  /**
   * Project-wide feature list. Server-side persisted canonical form requires
   * features be sorted by `featureId` (wire-and-recovery §"Canonical JSON").
   */
  features: EditorFeature[];
}

/**
 * The studio editor's authoritative read surface. Carries the project's source
 * + params + editable reference state in one coherent document.
 */
export interface EditorDocument {
  version: 1;
  projectId: string;
  /** Head snapshot id; null for a project with no history yet. */
  head: SnapshotId | null;
  sourceRevision: string;
  sourceFingerprint: string;
  editorRevision: string;
  scad: string;
  parameters: ParamDefinitionWire[];
  values: ParamValues;
  sidecar: EditorSidecar;
  sidecarStatus: EditorSidecarStatus;
  eligibility: EditorEligibility[];
}

/**
 * Why the editor's sidecar is in the state it is. The controller maps this to
 * its `disabled` reasons per S3-C §10.2 Q3 (typed enum).
 *
 * - `ready`: a modern sidecar is present and readable.
 * - `legacy-empty`: the project pre-dates S3 — no sidecar, but the editor can
 *   attach one on first mutation.
 * - `missing`: a modern project whose sidecar has gone missing — never normal.
 * - `corrupt`: modern sidecar bytes failed to parse — disable editing, keep view.
 * - `unsupported-version`: forward-compat case — disable editing, never downgrade.
 */
export type EditorSidecarStatus =
  | "ready"
  | "legacy-empty"
  | "missing"
  | "corrupt"
  | "unsupported-version";

/**
 * One feature's current eligibility for editing without a fresh proof.
 * `requires-proof` means the feature has changed since the last accepted proof
 * and must be re-verified before any further write can be authorised.
 */
export interface EditorEligibility {
  featureId: string;
  state: "requires-proof" | "unsupported";
  reason: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Editor command, verify, proof, commit, receipt, operation response
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A single S3 editor command. Three variants:
 * - `set-value`: edit one numeric binding of an existing feature.
 * - `put-feature`: author or replace a binding (creates a new featureId or
 *   bumps `bindingVersion` for an existing one).
 * - `remove-feature`: delete an existing feature.
 *
 * Discriminated by `kind`; parsers reject missing or wrong discriminants and
 * do not accept arbitrary command shapes.
 */
export type EditorCommand =
  | { kind: "set-value"; featureId: string; bindingVersion: number; value: number }
  | { kind: "put-feature"; feature: EditorFeature }
  | { kind: "remove-feature"; featureId: string; bindingVersion: number };

/** Why the editor is submitting a command. The server uses this for undo/redo traversal. */
export type EditorIntent = "edit" | "setup" | "undo" | "redo";

/** Identifies the original accepted operation being reversed or replayed. */
export interface EditorTraversal {
  operationId: string;
  direction: "undo" | "redo";
}

/** `POST /api/projects/:projectId/editor/verify`. */
export interface EditorVerifyRequest {
  version: 1;
  baseEditorRevision: string;
  command: EditorCommand;
  intent: EditorIntent;
  /** Mandatory for `undo`/`redo` intents; must be null for `edit`/`setup`. */
  traversal: EditorTraversal | null;
}

/** `POST /api/projects/:projectId/editor/verify` → 200 response. */
export interface EditorProofResponse {
  version: 1;
  proofId: string;
  commandDigest: string;
  baseEditorRevision: string;
  expiresAt: string;
}

/** `POST /api/projects/:projectId/editor/commands` request. */
export interface EditorCommitRequest extends EditorVerifyRequest {
  operationId: string;
  proofId: string;
}

/** `POST /api/projects/:projectId/editor/commands` → 200 response. */
export interface EditorReceipt {
  version: 1;
  projectId: string;
  operationId: string;
  requestDigest: string;
  baseEditorRevision: string;
  editorRevision: string;
  snapshotId: SnapshotId;
  values: ParamValues;
  sidecarDigest: string;
}

/**
 * `GET /api/projects/:projectId/editor/operations/:operationId`.
 *
 * The three states carry distinct recovery semantics
 * (wire-and-recovery §"Canonical identity and durable operation claims"):
 *
 * - `committed`: durable receipt, advance cursor and re-read the document.
 * - `definitely_not_committed`: explicit rejection/abort/unclaim with the
 *   exact `requestDigest` and a `reason`. A fresh attempt needs a new
 *   operation id and proof.
 * - `unknown`: identity is readable but terminal state could not be
 *   determined. The wire correction calls this the "commit-uncertainty"
 *   recovery surface — the controller renders it as `Resolving`, never
 *   `Rejected`.
 */
export type EditorOperationResponse =
  | { version: 1; state: "committed"; receipt: EditorReceipt }
  | {
      version: 1;
      state: "definitely_not_committed";
      requestDigest: string | null;
      reason: "unclaimed" | "rejected" | "aborted";
      error: ApiError | null;
    }
  | { version: 1; state: "unknown"; requestDigest: string | null };

// ═════════════════════════════════════════════════════════════════════════════
// 6. Agent editor context (D7 referenceability)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The frozen block `read_project` returns so the agent can cite features by
 * `featureId` rather than by ordinal or label.
 *
 * Referenceability only — this block is NOT proof of edit authority. The
 * shared invalidation boundary continues to invalidate the active editor
 * document on every agent write.
 *
 * The `sidecarStatus` and `eligibility` mirrors are present so the agent can
 * read "is this feature currently editable" without a second round-trip.
 */
export interface AgentEditorContext {
  version: 1;
  projectId: string;
  editorRevision: string;
  sourceRevision: string;
  sourceFingerprint: string;
  sidecarStatus: EditorSidecarStatus;
  features: EditorFeature[];
  eligibility: EditorEligibility[];
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Disk declaration (companion to SnapshotManifest in `snapshot.ts`)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The descriptor a `SnapshotManifest` carries for its embedded sidecar.
 * `file` is the sidecar's path inside the snapshot directory;
 * `sha256` is its lowercase 64-hex digest under canonical JSON.
 */
export interface EditorSnapshotRef {
  version: 1;
  file: "editor.json";
  sha256: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. Runtime parsers
//
// Each parser takes `unknown` and returns the typed value or throws an
// `EditorProtocolError`. The strict, throw-on-invalid shape keeps every wire
// boundary consistent — agents, servers and the browser controller all
// validate input the same way. Companion `safeParseXxx` functions return a
// discriminated union for callers that prefer not to use try/catch.
// ═════════════════════════════════════════════════════════════════════════════

/** Thrown by every `parseXxx` runtime parser on invalid input. */
export class EditorProtocolError extends Error {
  public override readonly name = "EditorProtocolError";
  constructor(
    message: string,
    /** Where the parse failure occurred, e.g. `"EditorDocument.sidecarStatus"`. */
    public readonly path: string
  ) {
    super(`${path}: ${message}`);
  }
}

/**
 * Parse-result discriminated union returned by every `safeParseXxx`. Mirrors
 * the shape used by zod's `safeParse` so call sites that already speak that
 * pattern work unchanged.
 */
export type EditorParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EditorProtocolError };

function fail(path: string, message: string): never {
  throw new EditorProtocolError(message, path);
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function expectObject(input: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(input)) fail(path, "expected object");
  return input;
}

/**
 * Strict check that `obj` carries no keys outside `allowed`. Wire-and-recovery
 * §"Parser rules" mandates rejection of "unknown fields" — this is what stops
 * clients from smuggling in executable metadata or shadow fields the wire spec
 * has not blessed.
 */
function rejectExtraFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(path, `unknown field ${JSON.stringify(key)}`);
    }
  }
}

function expectExactVersion(
  obj: Record<string, unknown>,
  expected: 1,
  path: string
): void {
  if (obj.version !== expected) {
    fail(path, `version must be ${expected}, got ${JSON.stringify(obj.version)}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
/**
 * ScadForge's editor revisions, source revisions, and source fingerprints are
 * all 64-hex digests under canonical JSON with a versioned domain prefix
 * (wire-and-recovery §"Canonical identity"). Wire parsing accepts only the
 * 64-hex form.
 */
const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

function isSha256Hex(s: string): boolean {
  return SHA256_RE.test(s);
}

function isIso8601Utc(s: string): boolean {
  return ISO_8601_RE.test(s);
}

function expectUuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    fail(path, `expected UUID, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectSha256Hex(value: unknown, path: string): string {
  if (typeof value !== "string" || !isSha256Hex(value)) {
    fail(path, `expected lowercase 64-hex SHA-256, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectHex64(value: unknown, path: string): string {
  if (typeof value !== "string" || !HEX64_RE.test(value)) {
    fail(path, `expected lowercase 64-hex digest, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectIso8601Utc(value: unknown, path: string): string {
  if (typeof value !== "string" || !isIso8601Utc(value)) {
    fail(path, `expected ISO-8601 UTC, got ${JSON.stringify(value)}`);
  }
  // Cross-check that the Date is valid; the regex alone misses some edge cases.
  if (Number.isNaN(Date.parse(value))) {
    fail(path, `expected ISO-8601 UTC, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, `expected finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    fail(path, `expected safe integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectPositiveSafeInteger(value: unknown, path: string): number {
  const n = expectSafeInteger(value, path);
  if (n < 1 || n > EDITOR_BINDING_VERSION_MAX) {
    fail(path, `expected positive safe integer ≤ ${EDITOR_BINDING_VERSION_MAX}, got ${n}`);
  }
  return n;
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, `expected non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function expectLabel(value: unknown, path: string): string {
  const s = expectNonEmptyString(value, path);
  // `[...s].length` counts Unicode code points, not UTF-16 code units.
  if ([...s].length > EDITOR_LABEL_MAX_CODE_POINTS) {
    fail(path, `label exceeds ${EDITOR_LABEL_MAX_CODE_POINTS} code points`);
  }
  return s;
}

function expectLiteral<T extends string>(
  value: unknown,
  expected: T,
  path: string
): T {
  if (value !== expected) fail(path, `expected literal ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  return expected;
}

function expectOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `expected one of [${allowed.join(", ")}], got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function expectOptionalOrNull<T>(
  value: unknown,
  parser: (v: unknown, p: string) => T,
  path: string
): T | null {
  if (value === undefined || value === null) return null;
  return parser(value, path);
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected array");
  return value;
}

function expectBoundedArray<T>(
  value: unknown,
  parser: (v: unknown, p: string) => T,
  path: string,
  max: number
): T[] {
  const arr = expectArray(value, path);
  if (arr.length > max) fail(path, `array length ${arr.length} exceeds ${max}`);
  return arr.map((item, i) => parser(item, `${path}[${i}]`));
}

function parseVec3(input: unknown, path: string): Vec3 {
  const arr = expectArray(input, path);
  if (arr.length !== 3) fail(path, `Vec3 must have length 3, got ${arr.length}`);
  const x = expectFiniteNumber(arr[0], `${path}[0]`);
  const y = expectFiniteNumber(arr[1], `${path}[1]`);
  const z = expectFiniteNumber(arr[2], `${path}[2]`);
  // Canonical JSON rule: -0 normalizes to 0 (wire-and-recovery §"Canonical
  // identity"). We accept both; -0 passes through as 0 in the parsed value so
  // digest comparisons stay stable.
  const nx = x === 0 ? 0 : x;
  const ny = y === 0 ? 0 : y;
  const nz = z === 0 ? 0 : z;
  return [nx, ny, nz];
}

function parseNormalizedVec3(input: unknown, path: string): Vec3 {
  const v = parseVec3(input, path);
  const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (Math.abs(norm - 1) > EDITOR_RADIAL_AXIS_NORM_TOLERANCE) {
    fail(
      path,
      `radial axis must be a unit vector (norm within ${EDITOR_RADIAL_AXIS_NORM_TOLERANCE} of 1), got ${norm}`
    );
  }
  return v;
}

// ── provenance ───────────────────────────────────────────────────────────────

function parseProvenance(input: unknown, path: string): Provenance {
  const obj = expectObject(input, path);
  const kind = expectOneOf(obj.kind, ["manual", "ai-proposed", "parser-proposed"] as const, `${path}.kind`);
  if (kind === "manual") {
    rejectExtraFields(obj, ["kind"], path);
    return { kind: "manual" };
  }
  rejectExtraFields(obj, ["kind", "confirmedBy"], path);
  expectLiteral(obj.confirmedBy, "user", `${path}.confirmedBy`);
  return { kind, confirmedBy: "user" };
}

// ── binding ──────────────────────────────────────────────────────────────────

function parseLinearBindingAnchor(
  value: unknown,
  path: string
): "min" | "max" | "center" {
  return expectOneOf(value, ["min", "max", "center"] as const, path);
}

function parseLinearBindingScale(value: unknown, path: string): 1 | 2 {
  if (value !== 1 && value !== 2) {
    fail(path, `linear binding scale must be 1 or 2, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseBinding(input: unknown, path: string): Binding {
  const obj = expectObject(input, path);
  const kind = expectOneOf(obj.kind, ["linear", "radial"] as const, `${path}.kind`);
  if (kind === "linear") {
    rejectExtraFields(obj, ["kind", "parameter", "axis", "mapping"], path);
    const parameter = expectNonEmptyString(obj.parameter, `${path}.parameter`);
    const axis = expectOneOf(obj.axis, ["x", "y", "z"] as const, `${path}.axis`);
    const mappingObj = expectObject(obj.mapping, `${path}.mapping`);
    rejectExtraFields(mappingObj, ["scale", "offset", "anchor"], `${path}.mapping`);
    const mapping = {
      scale: parseLinearBindingScale(mappingObj.scale, `${path}.mapping.scale`),
      offset: expectFiniteNumber(mappingObj.offset, `${path}.mapping.offset`),
      anchor: parseLinearBindingAnchor(mappingObj.anchor, `${path}.mapping.anchor`)
    };
    return { kind: "linear", parameter, axis, mapping };
  }
  // radial
  rejectExtraFields(
    obj,
    ["kind", "parameter", "center", "axis", "parameterMeaning", "presentation"],
    path
  );
  return {
    kind: "radial",
    parameter: expectNonEmptyString(obj.parameter, `${path}.parameter`),
    center: parseVec3(obj.center, `${path}.center`),
    axis: parseNormalizedVec3(obj.axis, `${path}.axis`),
    parameterMeaning: expectOneOf(
      obj.parameterMeaning,
      ["radius", "diameter"] as const,
      `${path}.parameterMeaning`
    ),
    presentation: expectOneOf(
      obj.presentation,
      ["radius", "diameter"] as const,
      `${path}.presentation`
    )
  };
}

// ── feature, sidecar ─────────────────────────────────────────────────────────

function parseEditorFeature(input: unknown, path: string): EditorFeature {
  const obj = expectObject(input, path);
  rejectExtraFields(
    obj,
    [
      "featureId",
      "label",
      "projectId",
      "createdAtRevision",
      "sourceFingerprint",
      "bindingVersion",
      "provenance",
      "binding"
    ],
    path
  );
  const feature: EditorFeature = {
    featureId: expectUuid(obj.featureId, `${path}.featureId`),
    label: expectLabel(obj.label, `${path}.label`),
    projectId: expectUuid(obj.projectId, `${path}.projectId`),
    createdAtRevision: expectHex64(obj.createdAtRevision, `${path}.createdAtRevision`),
    sourceFingerprint: expectHex64(obj.sourceFingerprint, `${path}.sourceFingerprint`),
    bindingVersion: expectPositiveSafeInteger(obj.bindingVersion, `${path}.bindingVersion`),
    provenance: parseProvenance(obj.provenance, `${path}.provenance`),
    binding: parseBinding(obj.binding, `${path}.binding`)
  };
  // No executable metadata: wire payload is JSON-only and `rejectExtraFields`
  // above guarantees no fields outside the explicit set.
  return feature;
}

export function parseEditorSidecar(input: unknown): EditorSidecar {
  const obj = expectObject(input, "EditorSidecar");
  expectExactVersion(obj, 1, "EditorSidecar");
  rejectExtraFields(obj, ["version", "features"], "EditorSidecar");
  const features = expectBoundedArray(
    obj.features,
    parseEditorFeature,
    "EditorSidecar.features",
    EDITOR_MAX_REFERENCE_ARRAY
  );
  // Reject duplicate featureIds — wire-and-recovery §"Parser rules".
  const seen = new Set<string>();
  for (const f of features) {
    if (seen.has(f.featureId)) {
      fail("EditorSidecar.features", `duplicate featureId ${f.featureId}`);
    }
    seen.add(f.featureId);
  }
  return { version: 1, features };
}

export function safeParseEditorSidecar(input: unknown): EditorParseResult<EditorSidecar> {
  try {
    return { ok: true, value: parseEditorSidecar(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

// ── eligibility, document ────────────────────────────────────────────────────

function parseEditorEligibility(input: unknown, path: string): EditorEligibility {
  const obj = expectObject(input, path);
  rejectExtraFields(obj, ["featureId", "state", "reason"], path);
  return {
    featureId: expectUuid(obj.featureId, `${path}.featureId`),
    state: expectOneOf(obj.state, ["requires-proof", "unsupported"] as const, `${path}.state`),
    reason: obj.reason === null ? null : expectNonEmptyString(obj.reason, `${path}.reason`)
  };
}

const SIDECAR_STATUSES = [
  "ready",
  "legacy-empty",
  "missing",
  "corrupt",
  "unsupported-version"
] as const;

const DOCUMENT_ALLOWED_KEYS = [
  "version",
  "projectId",
  "head",
  "sourceRevision",
  "sourceFingerprint",
  "editorRevision",
  "scad",
  "parameters",
  "values",
  "sidecar",
  "sidecarStatus",
  "eligibility"
] as const;

export function parseEditorDocument(input: unknown): EditorDocument {
  const obj = expectObject(input, "EditorDocument");
  expectExactVersion(obj, 1, "EditorDocument");
  // Validate top-level shape strictly BEFORE any nested parse, so the
  // error-path is the offending top-level field and not whatever nested
  // parser happened to run first.
  rejectExtraFields(obj, DOCUMENT_ALLOWED_KEYS, "EditorDocument");
  const headRaw = obj.head;
  const document: EditorDocument = {
    version: 1,
    projectId: expectUuid(obj.projectId, "EditorDocument.projectId"),
    head:
      headRaw === null
        ? null
        : typeof headRaw === "string"
          ? expectNonEmptyString(headRaw, "EditorDocument.head")
          : fail("EditorDocument.head", "must be a snapshot id or null"),
    sourceRevision: expectHex64(obj.sourceRevision, "EditorDocument.sourceRevision"),
    sourceFingerprint: expectHex64(obj.sourceFingerprint, "EditorDocument.sourceFingerprint"),
    editorRevision: expectHex64(obj.editorRevision, "EditorDocument.editorRevision"),
    scad:
      typeof obj.scad === "string"
        ? obj.scad
        : fail("EditorDocument.scad", "expected string"),
    parameters: expectBoundedArray(
      obj.parameters,
      // ParamDefinitionWire is mirrored from scad-core. We accept the shape
      // structurally here — its own contract is enforced by the source
      // document's parser. We re-validate required fields to keep the parser
      // honest at the editor wire boundary.
      (v, p) => {
        const pd = expectObject(v, p);
        if (typeof pd.name !== "string" || pd.name.length === 0) fail(`${p}.name`, "expected non-empty string");
        if (!["number", "boolean", "string", "vector"].includes(pd.type as string)) {
          fail(`${p}.type`, "expected ParamType");
        }
        return pd as unknown as ParamDefinitionWire;
      },
      "EditorDocument.parameters",
      EDITOR_MAX_REFERENCE_ARRAY
    ),
    values:
      typeof obj.values === "object" && obj.values !== null && !Array.isArray(obj.values)
        ? (obj.values as ParamValues)
        : fail("EditorDocument.values", "expected ParamValues object"),
    sidecar: parseEditorSidecar(obj.sidecar),
    sidecarStatus: expectOneOf(obj.sidecarStatus, SIDECAR_STATUSES, "EditorDocument.sidecarStatus"),
    eligibility: expectBoundedArray(
      obj.eligibility,
      parseEditorEligibility,
      "EditorDocument.eligibility",
      EDITOR_MAX_REFERENCE_ARRAY
    )
  };
  return document;
}

export function safeParseEditorDocument(input: unknown): EditorParseResult<EditorDocument> {
  try {
    return { ok: true, value: parseEditorDocument(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

// ── command, verify, proof, commit, receipt, operation response ──────────────

function parseSetValueCommand(obj: Record<string, unknown>, path: string): EditorCommand {
  rejectExtraFields(obj, ["kind", "featureId", "bindingVersion", "value"], path);
  return {
    kind: "set-value",
    featureId: expectUuid(obj.featureId, `${path}.featureId`),
    bindingVersion: expectPositiveSafeInteger(obj.bindingVersion, `${path}.bindingVersion`),
    value: expectFiniteNumber(obj.value, `${path}.value`)
  };
}

function parsePutFeatureCommand(obj: Record<string, unknown>, path: string): EditorCommand {
  rejectExtraFields(obj, ["kind", "feature"], path);
  return { kind: "put-feature", feature: parseEditorFeature(obj.feature, `${path}.feature`) };
}

function parseRemoveFeatureCommand(obj: Record<string, unknown>, path: string): EditorCommand {
  rejectExtraFields(obj, ["kind", "featureId", "bindingVersion"], path);
  return {
    kind: "remove-feature",
    featureId: expectUuid(obj.featureId, `${path}.featureId`),
    bindingVersion: expectPositiveSafeInteger(obj.bindingVersion, `${path}.bindingVersion`)
  };
}

export function parseEditorCommand(input: unknown): EditorCommand {
  const obj = expectObject(input, "EditorCommand");
  const kind = expectOneOf(obj.kind, ["set-value", "put-feature", "remove-feature"] as const, "EditorCommand.kind");
  switch (kind) {
    case "set-value":
      return parseSetValueCommand(obj, "EditorCommand");
    case "put-feature":
      return parsePutFeatureCommand(obj, "EditorCommand");
    case "remove-feature":
      return parseRemoveFeatureCommand(obj, "EditorCommand");
  }
}

export function safeParseEditorCommand(input: unknown): EditorParseResult<EditorCommand> {
  try {
    return { ok: true, value: parseEditorCommand(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

function parseEditorTraversal(input: unknown, path: string): EditorTraversal {
  const obj = expectObject(input, path);
  rejectExtraFields(obj, ["operationId", "direction"], path);
  return {
    operationId: expectUuid(obj.operationId, `${path}.operationId`),
    direction: expectOneOf(obj.direction, ["undo", "redo"] as const, `${path}.direction`)
  };
}

const VERIFY_ALLOWED_KEYS = ["version", "baseEditorRevision", "command", "intent", "traversal"] as const;

export function parseEditorVerifyRequest(input: unknown): EditorVerifyRequest {
  const obj = expectObject(input, "EditorVerifyRequest");
  expectExactVersion(obj, 1, "EditorVerifyRequest");
  rejectExtraFields(obj, VERIFY_ALLOWED_KEYS, "EditorVerifyRequest");
  const intent = expectOneOf(obj.intent, ["edit", "setup", "undo", "redo"] as const, "EditorVerifyRequest.intent");
  const traversalRaw = obj.traversal;
  if (traversalRaw === null) {
    if (intent === "undo" || intent === "redo") {
      fail("EditorVerifyRequest.traversal", `traversal is required for intent=${intent}`);
    }
  } else if (traversalRaw === undefined) {
    fail("EditorVerifyRequest.traversal", "traversal is required (use null for non-traversal intents)");
  } else {
    if (intent !== "undo" && intent !== "redo") {
      fail("EditorVerifyRequest.traversal", `traversal must be null for intent=${intent}`);
    }
    parseEditorTraversal(traversalRaw, "EditorVerifyRequest.traversal");
  }
  const base = expectHex64(obj.baseEditorRevision, "EditorVerifyRequest.baseEditorRevision");
  const command = parseEditorCommand(obj.command);
  return {
    version: 1,
    baseEditorRevision: base,
    command,
    intent,
    traversal: traversalRaw === null || traversalRaw === undefined ? null : parseEditorTraversal(traversalRaw, "EditorVerifyRequest.traversal")
  };
}

export function safeParseEditorVerifyRequest(input: unknown): EditorParseResult<EditorVerifyRequest> {
  try {
    return { ok: true, value: parseEditorVerifyRequest(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

export function parseEditorProofResponse(input: unknown): EditorProofResponse {
  const obj = expectObject(input, "EditorProofResponse");
  expectExactVersion(obj, 1, "EditorProofResponse");
  rejectExtraFields(
    obj,
    ["version", "proofId", "commandDigest", "baseEditorRevision", "expiresAt"],
    "EditorProofResponse"
  );
  return {
    version: 1,
    proofId: expectUuid(obj.proofId, "EditorProofResponse.proofId"),
    commandDigest: expectSha256Hex(obj.commandDigest, "EditorProofResponse.commandDigest"),
    baseEditorRevision: expectHex64(obj.baseEditorRevision, "EditorProofResponse.baseEditorRevision"),
    expiresAt: expectIso8601Utc(obj.expiresAt, "EditorProofResponse.expiresAt")
  };
}

export function safeParseEditorProofResponse(input: unknown): EditorParseResult<EditorProofResponse> {
  try {
    return { ok: true, value: parseEditorProofResponse(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

const COMMIT_ALLOWED_KEYS = [
  "version",
  "baseEditorRevision",
  "command",
  "intent",
  "traversal",
  "operationId",
  "proofId"
] as const;

export function parseEditorCommitRequest(input: unknown): EditorCommitRequest {
  const obj = expectObject(input, "EditorCommitRequest");
  expectExactVersion(obj, 1, "EditorCommitRequest");
  rejectExtraFields(obj, COMMIT_ALLOWED_KEYS, "EditorCommitRequest");
  // Reuse the verify parser for the shared shape, then layer the two commit-only
  // fields on top. Strip the commit-only keys before delegating so the verify
  // parser's strict unknown-field check does not falsely reject them.
  const verifyObj: Record<string, unknown> = { ...obj };
  delete verifyObj.operationId;
  delete verifyObj.proofId;
  const verify = parseEditorVerifyRequest(verifyObj);
  return {
    ...verify,
    operationId: expectUuid(obj.operationId, "EditorCommitRequest.operationId"),
    proofId: expectUuid(obj.proofId, "EditorCommitRequest.proofId")
  };
}

export function safeParseEditorCommitRequest(input: unknown): EditorParseResult<EditorCommitRequest> {
  try {
    return { ok: true, value: parseEditorCommitRequest(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

export function parseEditorReceipt(input: unknown): EditorReceipt {
  const obj = expectObject(input, "EditorReceipt");
  expectExactVersion(obj, 1, "EditorReceipt");
  rejectExtraFields(
    obj,
    [
      "version",
      "projectId",
      "operationId",
      "requestDigest",
      "baseEditorRevision",
      "editorRevision",
      "snapshotId",
      "values",
      "sidecarDigest"
    ],
    "EditorReceipt"
  );
  return {
    version: 1,
    projectId: expectUuid(obj.projectId, "EditorReceipt.projectId"),
    operationId: expectUuid(obj.operationId, "EditorReceipt.operationId"),
    requestDigest: expectSha256Hex(obj.requestDigest, "EditorReceipt.requestDigest"),
    baseEditorRevision: expectHex64(obj.baseEditorRevision, "EditorReceipt.baseEditorRevision"),
    editorRevision: expectHex64(obj.editorRevision, "EditorReceipt.editorRevision"),
    snapshotId: expectNonEmptyString(obj.snapshotId, "EditorReceipt.snapshotId"),
    values:
      typeof obj.values === "object" && obj.values !== null && !Array.isArray(obj.values)
        ? (obj.values as ParamValues)
        : fail("EditorReceipt.values", "expected ParamValues object"),
    sidecarDigest: expectSha256Hex(obj.sidecarDigest, "EditorReceipt.sidecarDigest")
  };
}

export function safeParseEditorReceipt(input: unknown): EditorParseResult<EditorReceipt> {
  try {
    return { ok: true, value: parseEditorReceipt(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

const COMMITTED_KEYS = ["version", "state", "receipt"] as const;
const NOT_COMMITTED_KEYS = [
  "version",
  "state",
  "requestDigest",
  "reason",
  "error"
] as const;
const UNKNOWN_KEYS = ["version", "state", "requestDigest"] as const;

export function parseEditorOperationResponse(input: unknown): EditorOperationResponse {
  const obj = expectObject(input, "EditorOperationResponse");
  expectExactVersion(obj, 1, "EditorOperationResponse");
  const state = expectOneOf(
    obj.state,
    ["committed", "definitely_not_committed", "unknown"] as const,
    "EditorOperationResponse.state"
  );
  if (state === "committed") {
    rejectExtraFields(obj, COMMITTED_KEYS, "EditorOperationResponse");
    return {
      version: 1,
      state: "committed",
      receipt: parseEditorReceipt(obj.receipt)
    };
  }
  if (state === "definitely_not_committed") {
    rejectExtraFields(obj, NOT_COMMITTED_KEYS, "EditorOperationResponse");
    const requestDigestRaw = obj.requestDigest;
    const errorObj = expectOptionalOrNull(
      obj.error,
      (v, p) => {
        if (!isPlainObject(v)) fail(p, "expected ApiError object or null");
        const code = (v as Record<string, unknown>).error_code;
        if (typeof code !== "string" || !(ERROR_CODES as readonly string[]).includes(code)) {
          fail(`${p}.error_code`, `expected ScadForgeErrorCode, got ${JSON.stringify(code)}`);
        }
        return {
          error_code: code as ScadForgeErrorCode,
          message: expectNonEmptyString((v as Record<string, unknown>).message, `${p}.message`)
        } satisfies ApiError;
      },
      "EditorOperationResponse.error"
    );
    return {
      version: 1,
      state: "definitely_not_committed",
      requestDigest:
        requestDigestRaw === null
          ? null
          : expectSha256Hex(requestDigestRaw, "EditorOperationResponse.requestDigest"),
      reason: expectOneOf(obj.reason, ["unclaimed", "rejected", "aborted"] as const, "EditorOperationResponse.reason"),
      error: errorObj
    };
  }
  // state === "unknown"
  rejectExtraFields(obj, UNKNOWN_KEYS, "EditorOperationResponse");
  const requestDigestRaw = obj.requestDigest;
  return {
    version: 1,
    state: "unknown",
    requestDigest:
      requestDigestRaw === null
        ? null
        : expectSha256Hex(requestDigestRaw, "EditorOperationResponse.requestDigest")
  };
}

export function safeParseEditorOperationResponse(
  input: unknown
): EditorParseResult<EditorOperationResponse> {
  try {
    return { ok: true, value: parseEditorOperationResponse(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

// ── agent editor context ─────────────────────────────────────────────────────

export function parseAgentEditorContext(input: unknown): AgentEditorContext {
  const obj = expectObject(input, "AgentEditorContext");
  expectExactVersion(obj, 1, "AgentEditorContext");
  rejectExtraFields(
    obj,
    [
      "version",
      "projectId",
      "editorRevision",
      "sourceRevision",
      "sourceFingerprint",
      "sidecarStatus",
      "features",
      "eligibility"
    ],
    "AgentEditorContext"
  );
  return {
    version: 1,
    projectId: expectUuid(obj.projectId, "AgentEditorContext.projectId"),
    editorRevision: expectHex64(obj.editorRevision, "AgentEditorContext.editorRevision"),
    sourceRevision: expectHex64(obj.sourceRevision, "AgentEditorContext.sourceRevision"),
    sourceFingerprint: expectHex64(obj.sourceFingerprint, "AgentEditorContext.sourceFingerprint"),
    sidecarStatus: expectOneOf(
      obj.sidecarStatus,
      SIDECAR_STATUSES,
      "AgentEditorContext.sidecarStatus"
    ),
    features: expectBoundedArray(
      obj.features,
      parseEditorFeature,
      "AgentEditorContext.features",
      EDITOR_MAX_REFERENCE_ARRAY
    ),
    eligibility: expectBoundedArray(
      obj.eligibility,
      parseEditorEligibility,
      "AgentEditorContext.eligibility",
      EDITOR_MAX_REFERENCE_ARRAY
    )
  };
}

export function safeParseAgentEditorContext(input: unknown): EditorParseResult<AgentEditorContext> {
  try {
    return { ok: true, value: parseAgentEditorContext(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}

// ── disk declaration ─────────────────────────────────────────────────────────

export function parseEditorSnapshotRef(input: unknown): EditorSnapshotRef {
  const obj = expectObject(input, "EditorSnapshotRef");
  expectExactVersion(obj, 1, "EditorSnapshotRef");
  rejectExtraFields(obj, ["version", "file", "sha256"], "EditorSnapshotRef");
  expectLiteral(obj.file, "editor.json", "EditorSnapshotRef.file");
  return {
    version: 1,
    file: "editor.json",
    sha256: expectSha256Hex(obj.sha256, "EditorSnapshotRef.sha256")
  };
}

export function safeParseEditorSnapshotRef(input: unknown): EditorParseResult<EditorSnapshotRef> {
  try {
    return { ok: true, value: parseEditorSnapshotRef(input) };
  } catch (error) {
    if (error instanceof EditorProtocolError) return { ok: false, error };
    throw error;
  }
}
