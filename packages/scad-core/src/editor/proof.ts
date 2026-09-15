// @scadforge/scad-core — server-authorized proof service (Issue #91, S3-B
// ticket B5).
//
// Server-authorized proof that one exact editor command produces the
// geometry its binding claims. Runs entirely OUTSIDE the project lock (the
// caller reads the coherent tuple under the lock first, then calls
// `runProbe` after releasing it — see `../store/recovered.ts`'s
// `withRecoveredProject` and this ticket's route). `lookupProofLocked`, the
// one function here that DOES take a locked `ctx`, is for B6's commit path.
//
// RADIAL MATCH-CRITERIA RULING (Tech Lead, S3-B B5 plan correction,
// recorded here and in the S3-B ticket story so B6 and reviewers judge new
// work against the same rule; the per-sample criteria themselves are
// implemented in `../geometry/radialMatch.ts`, which this file calls):
//
// Per sample, `../geometry/radialMatch.ts`'s `findRadialMatches` computes
// the MATCHED SET — every recognized region whose axis matches the
// declared axis (S2 angular threshold), whose center lies on the declared
// axis LINE (S2 distance threshold; axial position is deliberately not
// checked here), and whose measured diameter equals the binding-implied
// diameter at THAT sample's parameter value (via `parameterMeaning`),
// within the S2 radial tolerance.
//   - PASS iff the matched set is non-empty in EVERY sample AND it is the
//     SAME SET of regions, by region identity (this file's
//     `radialIdentity`/`sameIdentity`: each region's radial position, which
//     the match criteria already pin to the declared center, plus its
//     axial center — axial position is exactly the signal the per-sample
//     match criteria omit, so it is what distinguishes "the same regions
//     showed up again" from "a different set of regions happened to match
//     this time"), in every sample.
//   - REFUSE if the set is empty in any sample (no matching region).
//   - REFUSE if the set's region identity CHANGES between samples — a
//     surface that coincidentally matches the expected diameter at one
//     sample's parameter value but does not track the parameter (so it
//     joins or leaves the set as the value changes) is the real ambiguity;
//     message: "ambiguous radial mapping: a surface matches at one sample
//     but does not track the parameter".
//   - Collinear same-diameter segments that ALL track the parameter (e.g.
//     the S3-B B5 hinge fixture's three knuckle bores under `pin_d`) count
//     as ONE segmented feature and PASS, with the matched region count
//     recorded on the proof record's radial sample geometry (`regions`) so
//     the evidence is visible.
//
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding, EditorCommand, EditorFeature, EditorIntent, EditorTraversal } from "@scadforge/protocol";
import type { ParamSchema, ParamValues } from "../types.js";
import { ScadForgeError } from "../errors.js";
import { validateParamValues } from "../runner/params-validate.js";
import { exportMeshWithValidationStl } from "../runner/mesh-export.js";
import { writeOverrideParamsFile } from "../runner/params-file.js";
import { stageWork } from "../runner/workdir.js";
import { resolveOpenscadImage } from "../runner/docker.js";
import { parseStl } from "../validate/stl.js";
import { weldTriangleSoup } from "../validate/mesh-utils.js";
import { buildTopology } from "../geometry/topology.js";
import { findRadialMatches } from "../geometry/radialMatch.js";
import { principalAxisOf } from "../geometry/regionGrowth.js";
import type { Axis, Vec3 } from "../geometry/vec.js";
import type { WeldedMesh } from "../geometry/mesh.js";
import type { CylinderInspection } from "../geometry/inspectionTypes.js";
import { checkBindingEligibility } from "./eligibility.js";
import { commandDigest } from "./canonical.js";
import type { LockedProject } from "../store/recovered.js";
import * as canonicalModule from "./canonical.js";

/** Recognizer/probe algorithm version, recorded on every proof so a future threshold/algorithm change can be detected as invalidating old proofs. Bump on any change to the linear/radial check logic or the S2 recognizer thresholds. */
export const RECOGNIZER_VERSION = "s3-b-b5.1";

/** Proof TTL (wire-and-recovery spec, "Proof record and value domain"). */
export const PROOF_TTL_MS = 10 * 60 * 1000;

// Starting thresholds for the linear/radial probe checks (distinct from
// `../geometry/thresholds.ts`'s S2 recognizer thresholds, which govern
// recognition itself, not this probe's tolerance for comparing a rendered
// measurement against the declared relation). Calibrate on the clamp/hinge
// `@docker` fixtures; a test needing a different value is a signal to
// bring back for review, not to retune silently, same as S2's own table.
const PROOF_THRESHOLDS = {
  /** Max |rendered extent − (scale·param + offset)| in mm before a linear check refuses. */
  linearExtentToleranceMm: 0.05,
  /** Max drift in the anchored face's absolute position (mm) across samples before a linear check refuses. */
  linearAnchorToleranceMm: 0.05,
  /** Max drift (mm) in a matched region's axial center position across samples before it is treated as a DIFFERENT region for the cross-sample identity comparison (module header's ruling). A genuinely unchanged physical feature's axial position is numerically identical run to run; this only needs to absorb float noise, not tolerate real movement. */
  radialIdentityAxialToleranceMm: 0.05
} as const;

export interface ProofSample {
  kind: "baseline" | "candidate" | "perturbation";
  /** The complete authoritative param set rendered for this sample (every param — the ticket requires all params in every render, since a dependency subset has not been proven). */
  paramValues: ParamValues;
  geometry:
    | { kind: "linear"; extentMm: number; anchorPositionMm: number }
    /** `regions`: size of this sample's matched set (module header's match-criteria ruling) — 1 for an ordinary single bore, >1 for a legitimately segmented collinear feature (e.g. the hinge's three knuckle bores under `pin_d`), 0 when nothing matched (always a refusal). `diameterMm`/`centerMm` are representative (the first matched region's), since every region in a matched set shares the same diameter by construction. */
    | { kind: "radial"; regions: number; diameterMm: number | null; centerMm: [number, number, number] | null };
}

export interface ProofRecord {
  version: 1;
  proofId: string;
  projectId: string;
  baseEditorRevision: string;
  sourceFingerprint: string;
  /** Canonical complete authoritative params at the time of proof. */
  authoritativeParams: ParamValues;
  commandDigest: string;
  command: EditorCommand;
  intent: EditorIntent;
  traversal: EditorTraversal | null;
  /** Exact resulting candidate params; `null` for `remove-feature` (no rendering). */
  candidateParams: ParamValues | null;
  samples: ProofSample[];
  recognizerVersion: string;
  /** Pinned OpenSCAD engine image digest (`resolveOpenscadImage`). */
  engineImage: string;
  issuedAt: string;
  expiresAt: string;
  success: boolean;
}

export interface RunProbeInput {
  projectId: string;
  baseEditorRevision: string;
  /** Pinned authoritative source text this probe renders against. */
  scad: string;
  /** Canonical complete current authoritative params. */
  authoritativeParams: ParamValues;
  schema: ParamSchema;
  /** Current sidecar features, to resolve `featureId` → binding for `set-value`/`remove-feature`. */
  features: readonly EditorFeature[];
  command: EditorCommand;
  intent: EditorIntent;
  traversal: EditorTraversal | null;
  libraryPaths?: readonly string[];
  timeoutMs?: number;
}

export type ProbeResult = { status: "proved"; record: ProofRecord } | { status: "refused"; reason: string };

/**
 * Renders one complete param set against the pinned source and returns the
 * resulting mesh topology. The real implementation (`defaultRenderSampleMesh`
 * below) stages the source, overrides params, exports STL and welds it;
 * `proof.test.ts` injects a fake that returns synthetic meshes so the probe
 * logic is tested without a Docker engine.
 */
export type RenderSampleMesh = (scad: string, params: ParamValues, libraryPaths: readonly string[] | undefined, timeoutMs: number | undefined) => Promise<WeldedMesh>;

/** See `sourceFingerprint`'s own doc comment below for why this is injected rather than statically imported. */
export type ComputeSourceFingerprint = (scad: string) => string;

export interface ProofRenderDeps {
  renderSampleMesh: RenderSampleMesh;
  computeSourceFingerprint: ComputeSourceFingerprint;
}

async function defaultRenderSampleMesh(scad: string, params: ParamValues, libraryPaths: readonly string[] | undefined, timeoutMs: number | undefined): Promise<WeldedMesh> {
  const sourceDir = await mkdtemp(join(tmpdir(), "scadforge-proof-src-"));
  const sourcePath = join(sourceDir, "model.scad");
  try {
    await writeFile(sourcePath, scad, "utf8");
    const work = await stageWork(sourcePath, { libraryPaths });
    try {
      const overrideArgs = await writeOverrideParamsFile(work.dir, params);
      const meshResult = await exportMeshWithValidationStl(work.dir, work.modelName, "stl", overrideArgs, timeoutMs);
      const buf = await readFile(meshResult.stlPath);
      const triangles = parseStl(buf);
      const welded = weldTriangleSoup(triangles);
      return buildTopology(welded);
    } finally {
      await work.cleanup();
    }
  } finally {
    await rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `canonical.ts`'s `sourceFingerprint` is being added by B7 in parallel
 * (S3-B ticket story, "Source fingerprint and unreadable-sidecar revision",
 * Issue #92). A normal `import { sourceFingerprint } from "./canonical.js"`
 * fails at module-LOAD time with a real "does not provide an export named"
 * error the instant anything imports this file — not only when this
 * function is actually called — breaking every proof.ts test, not only
 * ones exercising it. Read through a namespace import instead so the rest
 * of this package keeps building and testing before B7 merges; only this
 * one call path is broken until then. This is NOT a reimplementation —
 * `defaultSourceFingerprint` never computes a hash itself, it only calls
 * through once the real export exists. Once B7 merges into
 * feat/s3-b-recoverable-store and this branch rebases onto it, replace
 * this whole function with a plain `import { sourceFingerprint } from
 * "./canonical.js"` and delete the namespace import above.
 */
function defaultSourceFingerprint(scad: string): string {
  const impl = (canonicalModule as unknown as { sourceFingerprint?: (scad: string) => string }).sourceFingerprint;
  if (!impl) {
    throw new ScadForgeError(
      "INTERNAL_ERROR",
      "canonical.ts's sourceFingerprint is not available yet (S3-B B7, Issue #92, not yet merged into feat/s3-b-recoverable-store) -- rebase this branch once it lands."
    );
  }
  return impl(scad);
}

const DEFAULT_DEPS: ProofRenderDeps = {
  renderSampleMesh: defaultRenderSampleMesh,
  computeSourceFingerprint: defaultSourceFingerprint
};

function toVec3(tuple: readonly [number, number, number]): Vec3 {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

function findFeature(features: readonly EditorFeature[], featureId: string, bindingVersion: number): EditorFeature | null {
  return features.find((f) => f.featureId === featureId && f.bindingVersion === bindingVersion) ?? null;
}

// ── perturbation search ──────────────────────────────────────────────────

function tryValue(schema: ParamSchema, parameter: string, candidate: number, exclude: readonly number[]): number | null {
  if (exclude.some((v) => Math.abs(v - candidate) < 1e-9)) return null;
  const result = validateParamValues(schema, { [parameter]: candidate });
  if (result.rejected.length > 0) return null;
  const accepted = result.accepted[parameter];
  return typeof accepted === "number" ? accepted : null;
}

/** Search magnitudes to try when perturbing `anchor`, nearest first — the parameter's own `step` when declared, else a fraction of its declared range, else a small fixed nudge. */
function searchMagnitudes(schema: ParamSchema, parameter: string): number[] {
  const param = schema.parameters.find((p) => p.name === parameter);
  if (!param) return [];
  if (typeof param.step === "number" && param.step > 0) return [param.step, param.step * 2, param.step * 5];
  if (typeof param.min === "number" && typeof param.max === "number" && param.max > param.min) {
    const range = param.max - param.min;
    return [range * 0.1, range * 0.25, range * 0.5];
  }
  return [1, 2, 5];
}

/** First legal value found in `direction` from `anchor`, not already in `exclude`, or `null` if none of the tried magnitudes validate. */
function findPerturbationInDirection(schema: ParamSchema, parameter: string, anchor: number, exclude: readonly number[], direction: 1 | -1): number | null {
  for (const magnitude of searchMagnitudes(schema, parameter)) {
    const candidate = tryValue(schema, parameter, anchor + direction * magnitude, exclude);
    if (candidate !== null) return candidate;
  }
  return null;
}

interface SamplePlan {
  /** Distinct legal parameter values to render, in the order they should be labeled: baseline, [candidate], perturbation(s). */
  values: { kind: ProofSample["kind"]; value: number }[];
}

/**
 * `put-feature`: baseline == candidate (no value is being changed by the
 * command itself), so up to two perturbations — one on each side of the
 * current value when the schema range allows both — give three distinct
 * sample points (correction C4). With only one legal side, two samples;
 * with none, the caller refuses "no legal perturbation".
 */
function planSetupSamples(schema: ParamSchema, parameter: string, currentValue: number): SamplePlan | null {
  const plus = findPerturbationInDirection(schema, parameter, currentValue, [currentValue], 1);
  const excludeForMinus = plus !== null ? [currentValue, plus] : [currentValue];
  const minus = findPerturbationInDirection(schema, parameter, currentValue, excludeForMinus, -1);

  if (plus === null && minus === null) return null; // no legal perturbation on either side -- degenerate, refuse

  const values: SamplePlan["values"] = [{ kind: "baseline", value: currentValue }];
  if (plus !== null) values.push({ kind: "perturbation", value: plus });
  if (minus !== null) values.push({ kind: "perturbation", value: minus });
  return { values };
}

/**
 * `set-value`: baseline (current) and candidate (`command.value`) are
 * already two distinct rendered points in the common case, plus one legal
 * perturbation beyond the candidate (tried first) or below the baseline.
 * The rare edge case where `command.value` numerically equals the current
 * value (a no-op the controller is expected to reject upstream, but the
 * probe does not assume that) falls back to the same two-sided search
 * `planSetupSamples` uses, for the same reason C4 gives there.
 */
function planSetValueSamples(schema: ParamSchema, parameter: string, baselineValue: number, candidateValue: number): SamplePlan | null {
  if (Math.abs(candidateValue - baselineValue) < 1e-9) {
    const setup = planSetupSamples(schema, parameter, baselineValue);
    if (setup === null) return null;
    // Relabel: the (single, since baseline==candidate here) value plays
    // both roles for a no-op-valued set-value command.
    return { values: setup.values.map((v) => (v.kind === "baseline" ? { kind: "candidate" as const, value: v.value } : v)) };
  }

  const exclude = [baselineValue, candidateValue];
  const towardBeyondCandidate = candidateValue >= baselineValue ? 1 : -1;
  const perturbation = findPerturbationInDirection(schema, parameter, candidateValue, exclude, towardBeyondCandidate) ?? findPerturbationInDirection(schema, parameter, baselineValue, exclude, (-towardBeyondCandidate) as 1 | -1);

  if (perturbation === null) return null;

  return {
    values: [
      { kind: "baseline", value: baselineValue },
      { kind: "candidate", value: candidateValue },
      { kind: "perturbation", value: perturbation }
    ]
  };
}

// ── linear/radial geometry checks ────────────────────────────────────────

function linearMeasurement(mesh: WeldedMesh, axis: Axis, anchor: "min" | "max" | "center"): { extentMm: number; anchorPositionMm: number } {
  if (mesh.positions.length === 0) return { extentMm: 0, anchorPositionMm: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const p of mesh.positions) {
    const v = p[axis];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const extentMm = max - min;
  const anchorPositionMm = anchor === "min" ? min : anchor === "max" ? max : (min + max) / 2;
  return { extentMm, anchorPositionMm };
}

function checkLinearSample(mesh: WeldedMesh, binding: Extract<Binding, { kind: "linear" }>, paramValue: number): { sample: ProofSample["geometry"]; refusal: string | null } {
  const { extentMm, anchorPositionMm } = linearMeasurement(mesh, binding.axis, binding.mapping.anchor);
  const expectedExtentMm = binding.mapping.scale * paramValue + binding.mapping.offset;
  const refusal = Math.abs(extentMm - expectedExtentMm) > PROOF_THRESHOLDS.linearExtentToleranceMm ? `rendered extent ${extentMm.toFixed(3)}mm does not track ${binding.mapping.scale}×${paramValue}+${binding.mapping.offset} = ${expectedExtentMm.toFixed(3)}mm` : null;
  return { sample: { kind: "linear", extentMm, anchorPositionMm }, refusal };
}

/**
 * A sample's matched set, reduced to what the cross-sample identity
 * comparison needs: one axial-center value per matched region (module
 * header's ruling — axial position is exactly the signal the per-sample
 * match criteria omit, so it is what "the same regions showed up again"
 * across samples is checked against). Sorted so two sets can be compared
 * position-by-position regardless of scan order.
 */
function radialIdentity(matches: readonly CylinderInspection[], axis: Axis): number[] {
  return matches.map((m) => m.center[axis]).sort((a, b) => a - b);
}

/** Same size, and every corresponding (sorted) axial center within tolerance — module header's "same set of regions, by region identity". */
function sameRadialIdentity(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= PROOF_THRESHOLDS.radialIdentityAxialToleranceMm);
}

/**
 * Never decides the refusal message itself: whether an empty matched set is
 * "no candidate at all" or "the bound surface moved/changed shape between
 * samples" depends on what OTHER samples found, which only the caller
 * (`runProbe`'s loop, which sees every sample in order) can determine.
 */
function checkRadialSample(mesh: WeldedMesh, binding: Extract<Binding, { kind: "radial" }>, axis: Axis, paramValue: number): { sample: ProofSample["geometry"]; matches: CylinderInspection[] } {
  const declaredCenter = toVec3(binding.center);
  const expectedDiameterMm = binding.parameterMeaning === "diameter" ? paramValue : paramValue * 2;
  const { matches } = findRadialMatches(mesh, declaredCenter, axis, expectedDiameterMm);

  if (matches.length === 0) {
    return { sample: { kind: "radial", regions: 0, diameterMm: null, centerMm: null }, matches };
  }

  const primary = matches[0];
  return {
    sample: { kind: "radial", regions: matches.length, diameterMm: primary.diameterMm, centerMm: [primary.center.x, primary.center.y, primary.center.z] },
    matches
  };
}

// ── main entry ────────────────────────────────────────────────────────────

function buildRecord(input: RunProbeInput, candidateParams: ParamValues | null, samples: ProofSample[], sourceFingerprint: string, engineImage: string): ProofRecord {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + PROOF_TTL_MS);
  const digestInput = { version: 1 as const, projectId: input.projectId, baseEditorRevision: input.baseEditorRevision, command: input.command, intent: input.intent, traversal: input.traversal };
  return {
    version: 1,
    proofId: randomUUID(),
    projectId: input.projectId,
    baseEditorRevision: input.baseEditorRevision,
    sourceFingerprint,
    authoritativeParams: input.authoritativeParams,
    commandDigest: commandDigest(digestInput),
    command: input.command,
    intent: input.intent,
    traversal: input.traversal,
    candidateParams,
    samples,
    recognizerVersion: RECOGNIZER_VERSION,
    engineImage,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    success: true
  };
}

/**
 * Runs the probe for one `EditorVerifyRequest`. Never renders under any
 * lock — the caller reads the coherent tuple (`RunProbeInput`'s fields)
 * under `withRecoveredProject` first, then calls this after the lock is
 * released. Returns a refusal (never throws for an ordinary degenerate
 * case) with a message safe to surface verbatim as `VALIDATION_FAILED`'s
 * reason — no source text or stack.
 */
export async function runProbe(input: RunProbeInput, depsOverride: Partial<ProofRenderDeps> = {}): Promise<ProbeResult> {
  const deps: ProofRenderDeps = { ...DEFAULT_DEPS, ...depsOverride };

  if (input.command.kind === "remove-feature") {
    const feature = findFeature(input.features, input.command.featureId, input.command.bindingVersion);
    if (feature === null) {
      return { status: "refused", reason: "The referenced feature and version were not found in the current sidecar." };
    }
    const sourceFingerprint = deps.computeSourceFingerprint(input.scad);
    return { status: "proved", record: buildRecord(input, null, [], sourceFingerprint, resolveOpenscadImage()) };
  }

  const binding: Binding = input.command.kind === "put-feature" ? input.command.feature.binding : (() => {
    const feature = findFeature(input.features, input.command.featureId, input.command.bindingVersion);
    return feature?.binding ?? null;
  })() as Binding;

  if (binding === null) {
    return { status: "refused", reason: "The referenced feature and version were not found in the current sidecar." };
  }

  const eligibilityReason = checkBindingEligibility(binding, input.schema);
  if (eligibilityReason !== null) {
    return { status: "refused", reason: eligibilityReason };
  }

  const baselineValue = input.authoritativeParams[binding.parameter];
  if (typeof baselineValue !== "number") {
    return { status: "refused", reason: `Parameter "${binding.parameter}"'s current value is not numeric.` };
  }

  let plan: SamplePlan | null;
  let candidateParams: ParamValues;

  if (input.command.kind === "put-feature") {
    plan = planSetupSamples(input.schema, binding.parameter, baselineValue);
    candidateParams = input.authoritativeParams;
  } else {
    const candidateValue = input.command.value;
    const candidateCheck = validateParamValues(input.schema, { [binding.parameter]: candidateValue });
    if (candidateCheck.rejected.length > 0) {
      return { status: "refused", reason: `Candidate value violates the parameter schema: ${candidateCheck.rejected[0].message}` };
    }
    plan = planSetValueSamples(input.schema, binding.parameter, baselineValue, candidateValue);
    candidateParams = { ...input.authoritativeParams, [binding.parameter]: candidateValue };
  }

  if (plan === null) {
    return { status: "refused", reason: `No legal in-range perturbation exists for parameter "${binding.parameter}".` };
  }

  let axis: Axis | null = null;
  if (binding.kind === "radial") {
    axis = principalAxisOf(toVec3(binding.axis));
    if (axis === null) {
      // Already caught by checkBindingEligibility above; kept as a
      // defensive second check so this function never renders against an
      // unsupported orientation even if that check is ever loosened.
      return { status: "refused", reason: "The radial binding's axis is not aligned with a principal axis (x, y or z)." };
    }
  }

  const samples: ProofSample[] = [];
  const radialIdentities: number[][] = []; // one per sample, only for radial bindings -- module header's cross-sample identity check
  let anyRadialSampleMatched = false; // baseline is always samples[0] -- distinguishes "no candidate at all" from "moved/changed between samples"
  for (const { kind, value } of plan.values) {
    const sampleParams: ParamValues = { ...input.authoritativeParams, [binding.parameter]: value };
    let mesh: WeldedMesh;
    try {
      mesh = await deps.renderSampleMesh(input.scad, sampleParams, input.libraryPaths, input.timeoutMs);
    } catch (err) {
      const typed = ScadForgeError.normalize(err, "RENDER_FAILED", "proof probe render failed");
      throw typed; // surfaced by the route as RENDER_FAILED/TIMEOUT per the error mapping table
    }

    if (binding.kind === "linear") {
      const { sample, refusal } = checkLinearSample(mesh, binding, value);
      samples.push({ kind, paramValues: sampleParams, geometry: sample });
      if (refusal !== null) return { status: "refused", reason: refusal };
    } else {
      const { sample, matches } = checkRadialSample(mesh, binding, axis as Axis, value);
      samples.push({ kind, paramValues: sampleParams, geometry: sample });
      if (matches.length === 0) {
        // A prior sample (baseline, or an earlier perturbation) already
        // matched, but this one doesn't: the bound surface moved or
        // changed shape when the parameter changed -- a fixed-center
        // radial binding cannot describe that edit. Distinct from "no
        // candidate ever existed" below.
        return {
          status: "refused",
          reason: anyRadialSampleMatched
            ? "the bound surface moves or changes shape when the parameter changes; a fixed-center radial binding cannot describe it"
            : "no circular region matched the declared center, axis and diameter"
        };
      }
      anyRadialSampleMatched = true;
      radialIdentities.push(radialIdentity(matches, axis as Axis));
    }
  }

  if (binding.kind === "linear") {
    const anchorPositions = samples.map((s) => (s.geometry.kind === "linear" ? s.geometry.anchorPositionMm : 0));
    const first = anchorPositions[0];
    const unstable = anchorPositions.some((p) => Math.abs(p - first) > PROOF_THRESHOLDS.linearAnchorToleranceMm);
    if (unstable) {
      return { status: "refused", reason: "The anchored face's position moved across samples; the binding's anchor does not hold." };
    }
  } else {
    // Module header's ruling: the matched set must be the SAME set of
    // regions, by region identity, in every sample -- a surface that
    // matches one sample's expected diameter but not another's (so it
    // joins or leaves the set) is the real ambiguity, not the count itself.
    const first = radialIdentities[0];
    const identityChanged = radialIdentities.some((identity) => !sameRadialIdentity(identity, first));
    if (identityChanged) {
      return { status: "refused", reason: "ambiguous radial mapping: a surface matches at one sample but does not track the parameter" };
    }
  }

  const sourceFingerprint = deps.computeSourceFingerprint(input.scad);
  return { status: "proved", record: buildRecord(input, candidateParams, samples, sourceFingerprint, resolveOpenscadImage()) };
}

// ── persistence ───────────────────────────────────────────────────────────

function proofsDir(projectDir: string): string {
  return join(projectDir, ".scadforge", "editor-proofs");
}

function proofPath(projectDir: string, proofId: string): string {
  return join(proofsDir(projectDir), `${proofId}.json`);
}

/** Writes `record` atomically (temp file + rename) to `.scadforge/editor-proofs/<proofId>.json`. */
export async function persistProofRecord(projectDir: string, record: ProofRecord): Promise<void> {
  const dir = proofsDir(projectDir);
  await mkdir(dir, { recursive: true });
  const finalPath = proofPath(projectDir, record.proofId);
  const tempPath = join(dir, `.${record.proofId}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(record, null, 2), "utf8");
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw ScadForgeError.normalize(err, "INTERNAL_ERROR", "failed to persist proof record");
  }
}

async function readProofRecord(projectDir: string, proofId: string): Promise<ProofRecord | null> {
  let raw: string;
  try {
    raw = await readFile(proofPath(projectDir, proofId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw ScadForgeError.normalize(err, "INTERNAL_ERROR", "failed to read proof record");
  }
  try {
    return JSON.parse(raw) as ProofRecord;
  } catch (err) {
    throw ScadForgeError.normalize(err, "INTERNAL_ERROR", "corrupt proof record");
  }
}

export type ProofLookupResult =
  | { status: "valid"; proof: ProofRecord }
  | { status: "not-found" }
  | { status: "expired" }
  | { status: "digest-mismatch" };

/**
 * For B6's commit path: rechecks TTL and the proof's own internal digest
 * consistency (its stored `commandDigest` must match one recomputed from
 * its own stored version/project/base-revision/command/intent/traversal —
 * a tamper/corruption check) under the caller's lock. `ctx` is accepted
 * (and required, per the story seam's signature) so a future identity
 * cross-check against the live coherent state can be added without
 * changing this function's signature again; B6 additionally compares the
 * returned record's `baseEditorRevision`/`sourceFingerprint` against its
 * own freshly-read coherent state before trusting the proof for a commit.
 */
export async function lookupProofLocked(ctx: LockedProject, proofId: string): Promise<ProofLookupResult> {
  const record = await readProofRecord(ctx.projectDir, proofId);
  if (record === null) return { status: "not-found" };

  if (Date.parse(record.expiresAt) <= Date.now()) {
    return { status: "expired" };
  }

  const recomputed = commandDigest({
    version: 1,
    projectId: record.projectId,
    baseEditorRevision: record.baseEditorRevision,
    command: record.command,
    intent: record.intent,
    traversal: record.traversal
  });
  if (recomputed !== record.commandDigest) {
    return { status: "digest-mismatch" };
  }

  return { status: "valid", proof: record };
}
