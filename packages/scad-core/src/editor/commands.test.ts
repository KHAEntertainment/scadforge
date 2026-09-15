// SPDX-License-Identifier: Apache-2.0
//
// S3-B ticket B6 (Issue #98): `applyEditorCommand`/`applyEditorTraversal`
// pure command-application unit tests. No I/O, no lock — the disk/proof
// wiring is exercised separately by `apps/server/src/services/scad-core-impl.test.ts`'s
// integration tests.

import { describe, expect, it } from "vitest";
import type { EditorFeature } from "@scadforge/protocol";
import { applyEditorCommand, applyEditorTraversal } from "./commands.js";
import type { AcceptedOperationRecord } from "../store/claims.js";

const PROJECT_ID = "hinged-box";
const BASE_REVISION = "a".repeat(64);
const SOURCE_FINGERPRINT = "b".repeat(64);
const FEATURE_ID = "11111111-1111-4111-8111-111111111111";
const OP_ID = "22222222-2222-4222-8222-222222222222";

function linearFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: FEATURE_ID,
    label: "Wall thickness",
    projectId: PROJECT_ID,
    createdAtRevision: BASE_REVISION,
    sourceFingerprint: SOURCE_FINGERPRINT,
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
    ...overrides
  };
}

describe("applyEditorCommand — set-value", () => {
  it("accepts a value change matching the proven candidate", () => {
    const feature = linearFeature();
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 5 },
      currentFeatures: [feature],
      currentParams: { wall: 2 },
      provenCandidateParams: { wall: 5 }
    });
    expect(result).toEqual({
      status: "accepted",
      nextFeatures: [feature],
      nextParams: { wall: 5 },
      accepted: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, parameter: "wall", beforeValue: 2, afterValue: 5 },
      message: expect.stringContaining("Wall thickness")
    });
  });

  it("refuses a no-op (candidate equals current) regardless of the proof, VALIDATION_FAILED", () => {
    const feature = linearFeature();
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 2 },
      currentFeatures: [feature],
      currentParams: { wall: 2 },
      // A proof for the (degenerate) equal candidate would still exist here --
      // the no-op check must fire BEFORE the proven-candidate cross-check.
      provenCandidateParams: { wall: 2 }
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.stringContaining("no-op") });
  });

  it("refuses when no feature exists at that binding version, VALIDATION_FAILED", () => {
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 2, value: 5 },
      currentFeatures: [linearFeature({ bindingVersion: 1 })],
      currentParams: { wall: 2 },
      provenCandidateParams: { wall: 5 }
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.any(String) });
  });

  it("refuses CONFLICT when the current params no longer match the proof's candidate", () => {
    const feature = linearFeature();
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 5 },
      currentFeatures: [feature],
      currentParams: { wall: 2, extra: 9 }, // drifted -- proof's candidateParams does not carry "extra"
      provenCandidateParams: { wall: 5 }
    });
    expect(result).toEqual({ status: "refused", code: "CONFLICT", message: expect.any(String) });
  });
});

describe("applyEditorCommand — put-feature create", () => {
  it("accepts a well-formed create and leaves params untouched", () => {
    const incoming = linearFeature();
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "put-feature", feature: incoming },
      currentFeatures: [],
      currentParams: { wall: 2 },
      provenCandidateParams: { wall: 2 }
    });
    expect(result).toEqual({
      status: "accepted",
      nextFeatures: [incoming],
      nextParams: { wall: 2 },
      accepted: { kind: "put-feature", featureId: FEATURE_ID, before: null, after: incoming },
      message: expect.any(String)
    });
  });

  it("refuses a create at bindingVersion other than 1, VALIDATION_FAILED", () => {
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "put-feature", feature: linearFeature({ bindingVersion: 2 }) },
      currentFeatures: [],
      currentParams: {},
      provenCandidateParams: {}
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.any(String) });
  });

  it("refuses a create whose createdAtRevision does not equal the base revision, VALIDATION_FAILED", () => {
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "put-feature", feature: linearFeature({ createdAtRevision: "c".repeat(64) }) },
      currentFeatures: [],
      currentParams: {},
      provenCandidateParams: {}
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.any(String) });
  });

  it("refuses a create whose sourceFingerprint does not match the current source, VALIDATION_FAILED", () => {
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "put-feature", feature: linearFeature({ sourceFingerprint: "d".repeat(64) }) },
      currentFeatures: [],
      currentParams: {},
      provenCandidateParams: {}
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.any(String) });
  });
});

describe("applyEditorCommand — put-feature replace", () => {
  it("accepts a replace at current+1 and swaps the feature record", () => {
    const existing = linearFeature({ bindingVersion: 1 });
    const replacement = linearFeature({ bindingVersion: 2, label: "Wall (v2)" });
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "put-feature", feature: replacement },
      currentFeatures: [existing],
      currentParams: { wall: 2 },
      provenCandidateParams: { wall: 2 }
    });
    expect(result).toEqual({
      status: "accepted",
      nextFeatures: [replacement],
      nextParams: { wall: 2 },
      accepted: { kind: "put-feature", featureId: FEATURE_ID, before: existing, after: replacement },
      message: expect.any(String)
    });
  });

  it("refuses a replace that is not exactly current+1, VALIDATION_FAILED", () => {
    const existing = linearFeature({ bindingVersion: 1 });
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "put-feature", feature: linearFeature({ bindingVersion: 3 }) },
      currentFeatures: [existing],
      currentParams: {},
      provenCandidateParams: {}
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.any(String) });
  });
});

describe("applyEditorCommand — remove-feature", () => {
  it("accepts removal of an existing feature at the exact version", () => {
    const existing = linearFeature();
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "remove-feature", featureId: FEATURE_ID, bindingVersion: 1 },
      currentFeatures: [existing],
      currentParams: { wall: 2 },
      provenCandidateParams: null
    });
    expect(result).toEqual({
      status: "accepted",
      nextFeatures: [],
      nextParams: { wall: 2 },
      accepted: { kind: "remove-feature", featureId: FEATURE_ID, before: existing },
      message: expect.any(String)
    });
  });

  it("refuses removal when no feature exists at that version, VALIDATION_FAILED", () => {
    const result = applyEditorCommand({
      projectId: PROJECT_ID,
      baseEditorRevision: BASE_REVISION,
      sourceFingerprint: SOURCE_FINGERPRINT,
      command: { kind: "remove-feature", featureId: FEATURE_ID, bindingVersion: 9 },
      currentFeatures: [linearFeature({ bindingVersion: 1 })],
      currentParams: {},
      provenCandidateParams: null
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.any(String) });
  });
});

describe("applyEditorTraversal", () => {
  const traversal = { operationId: OP_ID, direction: "undo" as const };

  it("undoes a set-value: restores the before value, requires current == after", () => {
    const record: AcceptedOperationRecord = { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, parameter: "wall", beforeValue: 2, afterValue: 5 };
    const result = applyEditorTraversal({
      intent: "undo",
      traversal,
      submittedCommand: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 2 },
      currentFeatures: [linearFeature()],
      currentParams: { wall: 5 },
      originalAccepted: record
    });
    expect(result).toEqual({
      status: "accepted",
      nextFeatures: [linearFeature()],
      nextParams: { wall: 2 },
      accepted: null,
      message: expect.stringContaining("undo")
    });
  });

  it("redoes a set-value: restores the after value, requires current == before", () => {
    const record: AcceptedOperationRecord = { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, parameter: "wall", beforeValue: 2, afterValue: 5 };
    const result = applyEditorTraversal({
      intent: "redo",
      traversal: { operationId: OP_ID, direction: "redo" },
      submittedCommand: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 5 },
      currentFeatures: [linearFeature()],
      currentParams: { wall: 2 },
      originalAccepted: record
    });
    expect(result).toMatchObject({ status: "accepted", nextParams: { wall: 5 }, accepted: null });
  });

  it("refuses a redo when the current param no longer matches the precondition, CONFLICT", () => {
    const record: AcceptedOperationRecord = { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, parameter: "wall", beforeValue: 2, afterValue: 5 };
    const result = applyEditorTraversal({
      intent: "redo",
      traversal: { operationId: OP_ID, direction: "redo" },
      submittedCommand: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 5 },
      currentFeatures: [linearFeature()],
      currentParams: { wall: 999 }, // drifted since the undo
      originalAccepted: record
    });
    expect(result).toEqual({ status: "refused", code: "CONFLICT", message: expect.any(String) });
  });

  it("refuses a submitted command that does not match the exact derived inverse, VALIDATION_FAILED", () => {
    const record: AcceptedOperationRecord = { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, parameter: "wall", beforeValue: 2, afterValue: 5 };
    const result = applyEditorTraversal({
      intent: "undo",
      traversal,
      submittedCommand: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 999 }, // wrong value
      currentFeatures: [linearFeature()],
      currentParams: { wall: 5 },
      originalAccepted: record
    });
    expect(result).toEqual({ status: "refused", code: "VALIDATION_FAILED", message: expect.any(String) });
  });

  it("undoes a create (put-feature, before: null) as a remove-feature", () => {
    const feature = linearFeature();
    const record: AcceptedOperationRecord = { kind: "put-feature", featureId: FEATURE_ID, before: null, after: feature };
    const result = applyEditorTraversal({
      intent: "undo",
      traversal,
      submittedCommand: { kind: "remove-feature", featureId: FEATURE_ID, bindingVersion: 1 },
      currentFeatures: [feature],
      currentParams: {},
      originalAccepted: record
    });
    expect(result).toEqual({ status: "accepted", nextFeatures: [], nextParams: {}, accepted: null, message: expect.any(String) });
  });

  it("redoes a create (put-feature, before: null) by restoring the after-image exactly, precondition requires absence", () => {
    const feature = linearFeature();
    const record: AcceptedOperationRecord = { kind: "put-feature", featureId: FEATURE_ID, before: null, after: feature };
    const result = applyEditorTraversal({
      intent: "redo",
      traversal: { operationId: OP_ID, direction: "redo" },
      submittedCommand: { kind: "put-feature", feature },
      currentFeatures: [],
      currentParams: {},
      originalAccepted: record
    });
    expect(result).toEqual({ status: "accepted", nextFeatures: [feature], nextParams: {}, accepted: null, message: expect.any(String) });
  });

  it("refuses a create-redo when the feature already exists (precondition: absent), CONFLICT", () => {
    const feature = linearFeature();
    const record: AcceptedOperationRecord = { kind: "put-feature", featureId: FEATURE_ID, before: null, after: feature };
    const result = applyEditorTraversal({
      intent: "redo",
      traversal: { operationId: OP_ID, direction: "redo" },
      submittedCommand: { kind: "put-feature", feature },
      currentFeatures: [feature], // already exists -- e.g. a concurrent create
      currentParams: {},
      originalAccepted: record
    });
    expect(result).toEqual({ status: "refused", code: "CONFLICT", message: expect.any(String) });
  });

  it("undoes a replace by restoring the before-image feature exactly", () => {
    const before = linearFeature({ bindingVersion: 1, label: "v1" });
    const after = linearFeature({ bindingVersion: 2, label: "v2" });
    const record: AcceptedOperationRecord = { kind: "put-feature", featureId: FEATURE_ID, before, after };
    const result = applyEditorTraversal({
      intent: "undo",
      traversal,
      submittedCommand: { kind: "put-feature", feature: before },
      currentFeatures: [after],
      currentParams: {},
      originalAccepted: record
    });
    expect(result).toEqual({ status: "accepted", nextFeatures: [before], nextParams: {}, accepted: null, message: expect.any(String) });
  });

  it("redoes a replace by restoring the after-image feature exactly", () => {
    const before = linearFeature({ bindingVersion: 1, label: "v1" });
    const after = linearFeature({ bindingVersion: 2, label: "v2" });
    const record: AcceptedOperationRecord = { kind: "put-feature", featureId: FEATURE_ID, before, after };
    const result = applyEditorTraversal({
      intent: "redo",
      traversal: { operationId: OP_ID, direction: "redo" },
      submittedCommand: { kind: "put-feature", feature: after },
      currentFeatures: [before],
      currentParams: {},
      originalAccepted: record
    });
    expect(result).toEqual({ status: "accepted", nextFeatures: [after], nextParams: {}, accepted: null, message: expect.any(String) });
  });

  it("undoes a remove-feature by restoring the before-image exactly, precondition requires absence", () => {
    const removed = linearFeature();
    const record: AcceptedOperationRecord = { kind: "remove-feature", featureId: FEATURE_ID, before: removed };
    const result = applyEditorTraversal({
      intent: "undo",
      traversal,
      submittedCommand: { kind: "put-feature", feature: removed },
      currentFeatures: [],
      currentParams: {},
      originalAccepted: record
    });
    expect(result).toEqual({ status: "accepted", nextFeatures: [removed], nextParams: {}, accepted: null, message: expect.any(String) });
  });

  it("redoes a remove-feature by re-removing at the exact original version", () => {
    const removed = linearFeature();
    const record: AcceptedOperationRecord = { kind: "remove-feature", featureId: FEATURE_ID, before: removed };
    const result = applyEditorTraversal({
      intent: "redo",
      traversal: { operationId: OP_ID, direction: "redo" },
      submittedCommand: { kind: "remove-feature", featureId: FEATURE_ID, bindingVersion: 1 },
      currentFeatures: [removed],
      currentParams: {},
      originalAccepted: record
    });
    expect(result).toEqual({ status: "accepted", nextFeatures: [], nextParams: {}, accepted: null, message: expect.any(String) });
  });

  it("refuses when no traversable operation record exists for the referenced id (unclaimed/rejected/aborted/chained-traversal), CONFLICT", () => {
    const result = applyEditorTraversal({
      intent: "undo",
      traversal,
      submittedCommand: { kind: "remove-feature", featureId: FEATURE_ID, bindingVersion: 1 },
      currentFeatures: [],
      currentParams: {},
      originalAccepted: null
    });
    expect(result).toEqual({ status: "refused", code: "CONFLICT", message: expect.any(String) });
  });
});
