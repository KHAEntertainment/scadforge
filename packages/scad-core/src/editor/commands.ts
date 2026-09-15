// @scadforge/scad-core — editor command application (Issue #98, S3-B ticket
// B6).
//
// Pure, synchronous, no I/O: feature-lifecycle validation, sidecar mutation
// and undo/redo inverse derivation for `POST .../editor/commands`. Every
// disk/lock/proof concern (reading the coherent state, checking
// `baseEditorRevision`/proof identity, staging/deciding/publishing through
// B4) stays in `apps/server/src/services/scad-core-impl.ts` — this module
// only decides WHAT the resulting feature list and params should be, given
// the current state and an already-authorized command.
//
// ── What rests on the proof vs. what is re-run here (Tech Lead correction
// C1 on Issue #98) ───────────────────────────────────────────────────────
//
// The caller only reaches this module after `baseEditorRevision` matches the
// CURRENT editor revision and `lookupProofLocked` has confirmed the proof's
// own `commandDigest` matches a digest recomputed from THIS request's
// `{version, projectId, baseEditorRevision, command, intent, traversal}`.
// Since a SHA-256 digest match is a preimage guarantee, that alone already
// proves the request's `command` is bit-for-bit what `/verify` rendered and
// accepted — so this module never re-runs `validateParamValues`, never
// re-derives the Customizer schema, and never re-renders. It DOES still run
// every check the spec lists as a commit-time responsibility, because a
// matching proof only established that the CANDIDATE geometry/value is
// legal in the abstract, never that the CURRENT live sidecar/params still
// support applying it:
//   - feature-exists-at-version, create/replace lifecycle fields, remove
//     existence (§ish "Apply the command rules") — pure lookups against the
//     CURRENT feature list, cheap, always re-run;
//   - the owner's no-op rule for set-value — re-run even though a stale
//     proof could theoretically have been taken against a different value;
//   - every traversal direction / derived-inverse / precondition check —
//     always re-run; a proof only proves the SUBMITTED command's geometry,
//     never that it is the CORRECT inverse of the referenced operation;
//   - a cheap equality assertion that the request's implied resulting
//     params equal the proof's own `candidateParams` (defense in depth: the
//     `baseEditorRevision` match already implies this, since a revision
//     digests both source+params and the sidecar, but the assertion is
//     free and the Tech Lead asked for it explicitly).
//
// SPDX-License-Identifier: Apache-2.0

import type { EditorCommand, EditorFeature, EditorIntent, EditorTraversal } from "@scadforge/protocol";
import type { ParamValues } from "../types.js";
import { canonicalJson } from "./canonical.js";
import type { AcceptedOperationRecord } from "../store/claims.js";

/** A refusal this module hands back to the caller — the caller maps these directly onto the frozen error codes (never invents a third code). */
export interface EditorCommandRefusal {
  status: "refused";
  code: "VALIDATION_FAILED" | "CONFLICT";
  message: string;
}

export interface EditorCommandAccepted {
  status: "accepted";
  /** The complete new feature list (any order — the caller canonicalizes via `canonicalSidecar` when serializing to disk). */
  nextFeatures: EditorFeature[];
  /** The complete new authoritative param values. Identical to the input for `put-feature`/`remove-feature` (neither touches a value). */
  nextParams: ParamValues;
  /**
   * The before/after record THIS operation's own future undo/redo will
   * need, for the caller to persist on the new claim's committed terminal
   * state. `null` from {@link applyEditorTraversal} ONLY — an undo/redo
   * commit deliberately does not get its own record (see that function's
   * doc comment), so the caller must never persist a record for an
   * undo/redo commit even though this field is otherwise always present.
   */
  accepted: AcceptedOperationRecord | null;
  /** Human-readable, names the feature and intent — becomes the snapshot's `message.md` (never the full `.scad`, CLAUDE.md hard rule 5). */
  message: string;
}

export type EditorCommandResult = EditorCommandAccepted | EditorCommandRefusal;

function refuse(code: EditorCommandRefusal["code"], message: string): EditorCommandRefusal {
  return { status: "refused", code, message };
}

function accept(input: Omit<EditorCommandAccepted, "status">): EditorCommandAccepted {
  return { status: "accepted", ...input };
}

function findFeature(features: readonly EditorFeature[], featureId: string, bindingVersion: number): EditorFeature | null {
  return features.find((f) => f.featureId === featureId && f.bindingVersion === bindingVersion) ?? null;
}

function findFeatureById(features: readonly EditorFeature[], featureId: string): EditorFeature | null {
  return features.find((f) => f.featureId === featureId) ?? null;
}

/** Shallow key/value equality over two complete `ParamValues` objects — exact match, no coercion. */
function paramValuesEqual(a: ParamValues, b: ParamValues): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

// ═════════════════════════════════════════════════════════════════════════════
// Ordinary (edit / setup) command application
// ═════════════════════════════════════════════════════════════════════════════

export interface ApplyEditorCommandInput {
  projectId: string;
  baseEditorRevision: string;
  sourceFingerprint: string;
  command: EditorCommand;
  /** Current sidecar features — any order. */
  currentFeatures: readonly EditorFeature[];
  currentParams: ParamValues;
  /**
   * The already-verified proof's own resulting candidate params. `null` for
   * `remove-feature` (the proof never renders one for a pure removal).
   */
  provenCandidateParams: ParamValues | null;
}

/** `intent: "edit" | "setup"` only. Traversal (`undo`/`redo`) goes through {@link applyEditorTraversal} instead — the two paths enforce different lifecycle rules (ordinary create/replace version arithmetic vs. exact historical restoration). */
export function applyEditorCommand(input: ApplyEditorCommandInput): EditorCommandResult {
  const { projectId, baseEditorRevision, sourceFingerprint, command, currentFeatures, currentParams, provenCandidateParams } = input;

  if (command.kind === "set-value") {
    const feature = findFeature(currentFeatures, command.featureId, command.bindingVersion);
    if (!feature) {
      return refuse("VALIDATION_FAILED", `No feature "${command.featureId}" at binding version ${command.bindingVersion}.`);
    }
    const parameter = feature.binding.parameter;
    const beforeValue = currentParams[parameter];
    if (typeof beforeValue !== "number") {
      return refuse("VALIDATION_FAILED", `Parameter "${parameter}" is not currently a number.`);
    }
    const afterValue = command.value;
    // Owner decision (S3-B ticket story): a no-op set-value is a definite
    // rejection, whatever the proof says — checked BEFORE the proof
    // cross-check below, never bypassed by a stale/unusual proof record.
    if (beforeValue === afterValue) {
      return refuse("VALIDATION_FAILED", "The candidate value is identical to the current value (no-op).");
    }
    const nextParams: ParamValues = { ...currentParams, [parameter]: afterValue };
    if (provenCandidateParams === null || !paramValuesEqual(nextParams, provenCandidateParams)) {
      return refuse("CONFLICT", "The current parameters no longer match the values the proof was taken against; refresh and re-verify.");
    }
    return accept({
      nextFeatures: currentFeatures.slice(),
      nextParams,
      accepted: { kind: "set-value", featureId: feature.featureId, bindingVersion: feature.bindingVersion, parameter, beforeValue, afterValue },
      message: `Set ${feature.label || feature.featureId} (edit)`
    });
  }

  if (command.kind === "put-feature") {
    const incoming = command.feature;
    const existing = findFeatureById(currentFeatures, incoming.featureId);

    if (!existing) {
      // Create.
      if (incoming.bindingVersion !== 1) {
        return refuse("VALIDATION_FAILED", "A new feature must start at bindingVersion 1.");
      }
      if (incoming.projectId !== projectId) {
        return refuse("VALIDATION_FAILED", "The feature's projectId does not match this project.");
      }
      if (incoming.sourceFingerprint !== sourceFingerprint) {
        return refuse("VALIDATION_FAILED", "The feature's sourceFingerprint does not match the current source.");
      }
      if (incoming.createdAtRevision !== baseEditorRevision) {
        return refuse("VALIDATION_FAILED", "createdAtRevision must equal the base editor revision.");
      }
      if (provenCandidateParams === null || !paramValuesEqual(currentParams, provenCandidateParams)) {
        return refuse("CONFLICT", "The current parameters no longer match the values the proof was taken against; refresh and re-verify.");
      }
      return accept({
        nextFeatures: [...currentFeatures, incoming],
        nextParams: currentParams,
        accepted: { kind: "put-feature", featureId: incoming.featureId, before: null, after: incoming },
        message: `Created ${incoming.label || incoming.featureId} (setup)`
      });
    }

    // Replace.
    if (incoming.bindingVersion !== existing.bindingVersion + 1) {
      return refuse("VALIDATION_FAILED", `Binding replacement must be version ${existing.bindingVersion + 1}.`);
    }
    if (incoming.projectId !== projectId) {
      return refuse("VALIDATION_FAILED", "The feature's projectId does not match this project.");
    }
    if (incoming.sourceFingerprint !== sourceFingerprint) {
      return refuse("VALIDATION_FAILED", "The feature's sourceFingerprint does not match the current source.");
    }
    if (provenCandidateParams === null || !paramValuesEqual(currentParams, provenCandidateParams)) {
      return refuse("CONFLICT", "The current parameters no longer match the values the proof was taken against; refresh and re-verify.");
    }
    return accept({
      nextFeatures: currentFeatures.map((f) => (f.featureId === existing.featureId ? incoming : f)),
      nextParams: currentParams,
      accepted: { kind: "put-feature", featureId: existing.featureId, before: existing, after: incoming },
      message: `Replaced ${incoming.label || incoming.featureId} (setup)`
    });
  }

  // remove-feature
  const existing = findFeature(currentFeatures, command.featureId, command.bindingVersion);
  if (!existing) {
    return refuse("VALIDATION_FAILED", `No feature "${command.featureId}" at binding version ${command.bindingVersion}.`);
  }
  return accept({
    nextFeatures: currentFeatures.filter((f) => f.featureId !== command.featureId),
    nextParams: currentParams,
    accepted: { kind: "remove-feature", featureId: existing.featureId, before: existing },
    message: `Removed ${existing.label || existing.featureId}`
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Traversal (undo / redo) command application
// ═════════════════════════════════════════════════════════════════════════════

type Precondition =
  | { kind: "param-equals"; parameter: string; expected: number }
  | { kind: "feature-exists"; featureId: string; bindingVersion: number }
  | { kind: "feature-absent"; featureId: string };

interface DerivedTraversal {
  command: EditorCommand;
  precondition: Precondition;
}

/**
 * Wire-and-recovery §"Session cursor transitions": "undo of a value change
 * sets the before value with precondition that the current value equals the
 * after value; redo the reverse; undo of a create is a remove; undo of a
 * replace or remove restores the recorded before-image bytes, id and
 * version exactly." Pure derivation from the ORIGINAL accepted operation's
 * before/after record — never from the client's own guess (that guess is
 * only ever ACCEPTED if it equals this).
 */
function deriveTraversal(record: AcceptedOperationRecord, direction: "undo" | "redo"): DerivedTraversal {
  if (record.kind === "set-value") {
    return direction === "undo"
      ? {
          command: { kind: "set-value", featureId: record.featureId, bindingVersion: record.bindingVersion, value: record.beforeValue },
          precondition: { kind: "param-equals", parameter: record.parameter, expected: record.afterValue }
        }
      : {
          command: { kind: "set-value", featureId: record.featureId, bindingVersion: record.bindingVersion, value: record.afterValue },
          precondition: { kind: "param-equals", parameter: record.parameter, expected: record.beforeValue }
        };
  }

  if (record.kind === "put-feature") {
    if (direction === "undo") {
      return record.before === null
        ? {
            // Undo of a create is a remove.
            command: { kind: "remove-feature", featureId: record.featureId, bindingVersion: record.after.bindingVersion },
            precondition: { kind: "feature-exists", featureId: record.featureId, bindingVersion: record.after.bindingVersion }
          }
        : {
            // Undo of a replace restores the before-image exactly.
            command: { kind: "put-feature", feature: record.before },
            precondition: { kind: "feature-exists", featureId: record.featureId, bindingVersion: record.after.bindingVersion }
          };
    }
    // Redo restores the after-image exactly (create or replace).
    return {
      command: { kind: "put-feature", feature: record.after },
      precondition:
        record.before === null
          ? { kind: "feature-absent", featureId: record.featureId }
          : { kind: "feature-exists", featureId: record.featureId, bindingVersion: record.before.bindingVersion }
    };
  }

  // remove-feature
  return direction === "undo"
    ? {
        // Undo of a remove restores the before-image exactly.
        command: { kind: "put-feature", feature: record.before },
        precondition: { kind: "feature-absent", featureId: record.featureId }
      }
    : {
        // Redo re-removes it.
        command: { kind: "remove-feature", featureId: record.featureId, bindingVersion: record.before.bindingVersion },
        precondition: { kind: "feature-exists", featureId: record.featureId, bindingVersion: record.before.bindingVersion }
      };
}

function checkPrecondition(precondition: Precondition, currentFeatures: readonly EditorFeature[], currentParams: ParamValues): string | null {
  switch (precondition.kind) {
    case "param-equals":
      return currentParams[precondition.parameter] === precondition.expected
        ? null
        : `Parameter "${precondition.parameter}" no longer equals the value this traversal requires; refresh and retry.`;
    case "feature-exists":
      return findFeature(currentFeatures, precondition.featureId, precondition.bindingVersion)
        ? null
        : `Feature "${precondition.featureId}" is no longer at binding version ${precondition.bindingVersion}; refresh and retry.`;
    case "feature-absent":
      return findFeatureById(currentFeatures, precondition.featureId)
        ? `Feature "${precondition.featureId}" unexpectedly already exists; refresh and retry.`
        : null;
  }
}

function applyDerivedCommand(
  command: EditorCommand,
  currentFeatures: readonly EditorFeature[],
  currentParams: ParamValues
): { nextFeatures: EditorFeature[]; nextParams: ParamValues } {
  if (command.kind === "set-value") {
    const feature = findFeature(currentFeatures, command.featureId, command.bindingVersion);
    // Unreachable given the precondition check already ran, but keeps this
    // function total rather than trusting an upstream invariant silently.
    if (!feature) return { nextFeatures: currentFeatures.slice(), nextParams: currentParams };
    return { nextFeatures: currentFeatures.slice(), nextParams: { ...currentParams, [feature.binding.parameter]: command.value } };
  }
  if (command.kind === "put-feature") {
    const existingIndex = currentFeatures.findIndex((f) => f.featureId === command.feature.featureId);
    const nextFeatures =
      existingIndex === -1
        ? [...currentFeatures, command.feature]
        : currentFeatures.map((f, i) => (i === existingIndex ? command.feature : f));
    return { nextFeatures, nextParams: currentParams };
  }
  // remove-feature
  return { nextFeatures: currentFeatures.filter((f) => f.featureId !== command.featureId), nextParams: currentParams };
}

export interface ApplyEditorTraversalInput {
  /** The intent named by the request — must be `"undo"` or `"redo"`. */
  intent: EditorIntent;
  traversal: EditorTraversal;
  /** The command the CLIENT submitted — must equal the server-derived inverse exactly, or this is refused. */
  submittedCommand: EditorCommand;
  currentFeatures: readonly EditorFeature[];
  currentParams: ParamValues;
  /**
   * The referenced operation's own before/after record, from
   * `lookupClaimLocked(ctx, traversal.operationId)`'s `accepted` field.
   * `null` when that operation was never committed, is not found, OR was
   * itself an undo/redo (this module deliberately never attaches an
   * `accepted` record to an undo/redo's own claim — see the note on
   * `EditorCommandAccepted` — so a chained traversal attempt naturally lands
   * here as `null` and is refused, matching the wire spec's session-log
   * model where only `"edit"`/`"setup"` entries are ever traversable).
   */
  originalAccepted: AcceptedOperationRecord | null;
}

/**
 * `intent: "undo" | "redo"` only. Traversal never gets its OWN
 * `AcceptedOperationRecord` (an accepted undo/redo receipt is committed
 * without one) — the client's session log only ever holds `"edit"`/
 * `"setup"` entries (wire-and-recovery's `OperationEntry.intent` type), so
 * nothing ever legitimately needs to further traverse an undo/redo commit
 * itself.
 */
export function applyEditorTraversal(input: ApplyEditorTraversalInput): EditorCommandResult {
  const { traversal, submittedCommand, currentFeatures, currentParams, originalAccepted } = input;

  if (originalAccepted === null) {
    return refuse("CONFLICT", "No traversable operation was found for the referenced operation id; refresh and submit a new operation.");
  }

  const derived = deriveTraversal(originalAccepted, traversal.direction);

  if (canonicalJson(submittedCommand) !== canonicalJson(derived.command)) {
    return refuse("VALIDATION_FAILED", "The submitted command does not match the exact inverse of the referenced operation.");
  }

  const preconditionError = checkPrecondition(derived.precondition, currentFeatures, currentParams);
  if (preconditionError !== null) {
    return refuse("CONFLICT", preconditionError);
  }

  const { nextFeatures, nextParams } = applyDerivedCommand(derived.command, currentFeatures, currentParams);
  const verb = traversal.direction === "undo" ? "Undid" : "Redid";
  const label =
    derived.command.kind === "put-feature"
      ? derived.command.feature.label || derived.command.feature.featureId
      : derived.command.featureId;
  return accept({
    nextFeatures,
    nextParams,
    // `null`, deliberately: an accepted undo/redo commit does not get its
    // own before/after record, so nothing can ever reference ITS
    // operationId for a further traversal (see this function's doc
    // comment). The caller must persist this as `accepted: null` — never
    // substitute `originalAccepted` here, which would wrongly make the new
    // commit traversable via the OLD record.
    accepted: null,
    message: `${verb} ${label} (${traversal.direction})`
  });
}
