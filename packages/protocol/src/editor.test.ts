// FROZEN CONTRACT — ScadForge Issue #68 (S3-A). These assertions are the
// proof for `src/editor.ts`: parser rules from wire-and-recovery
// §"Exact additive protocol proposal", schema version pin, route-table
// separation from `API_ROUTES`, label / array / radial-axis / digest /
// UUID strictness. Do NOT edit them inside a feature PR — changes require a
// Tech-Lead-approved contract-change issue, merged separately.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  EDITOR_BINDING_VERSION_MAX,
  EDITOR_LABEL_MAX_CODE_POINTS,
  EDITOR_MAX_REFERENCE_ARRAY,
  EDITOR_RADIAL_AXIS_NORM_TOLERANCE,
  EDITOR_ROUTES,
  EDITOR_SCHEMA_VERSION,
  EditorProtocolError,
  parseAgentEditorContext,
  parseEditorCommand,
  parseEditorCommitRequest,
  parseEditorDocument,
  parseEditorOperationResponse,
  parseEditorProofResponse,
  parseEditorReceipt,
  parseEditorSidecar,
  parseEditorSnapshotRef,
  parseEditorVerifyRequest,
  safeParseAgentEditorContext,
  safeParseEditorCommand,
  safeParseEditorCommitRequest,
  safeParseEditorDocument,
  safeParseEditorOperationResponse,
  safeParseEditorProofResponse,
  safeParseEditorReceipt,
  safeParseEditorSidecar,
  safeParseEditorSnapshotRef,
  safeParseEditorVerifyRequest
} from "./index.js";
import {
  API_BASE_PATH,
  API_ROUTES,
  ERROR_CODES,
  type AgentEditorContext,
  type EditorCommand,
  type EditorCommitRequest,
  type EditorDocument,
  type EditorEligibility,
  type EditorFeature,
  type EditorProofResponse,
  type EditorReceipt,
  type EditorSidecar,
  type EditorVerifyRequest
} from "./index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "11111111-2222-4333-8444-666666666666";
const HEX64 = (seed: number) => seed.toString(16).padStart(64, "0");
const HEX64_A = HEX64(1);
const HEX64_B = HEX64(2);
const HEX64_C = HEX64(3);
const HEX64_D = HEX64(4);

const ISO_NOW = "2026-09-12T00:00:00.000Z";

// `projectId` accepts the same safe-id rule the server enforces on every
// route (`isSafeId` in `apps/server/src/services/validation.ts`), not a UUID
// (contract-change Issue #93). UUID-shaped ids also satisfy the rule, so
// existing UUID fixtures (`UUID_B` above) stay valid without change.
const VALID_PROJECT_IDS = ["hinged-box", "my-bracket-2", "Project.v1_2", UUID_B];
const INVALID_PROJECT_IDS = ["", ".", "..", "a..b", "a/b", "a\\b", "a".repeat(129), "a b", "é"];

function makeFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: UUID_A,
    label: "wall",
    projectId: UUID_B,
    createdAtRevision: HEX64_A,
    sourceFingerprint: HEX64_B,
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: {
      kind: "linear",
      parameter: "wall",
      axis: "z",
      mapping: { scale: 1, offset: 0, anchor: "min" }
    },
    ...overrides
  };
}

function makeSidecar(features: EditorFeature[] = [makeFeature()]): EditorSidecar {
  // Deterministic feature id ordering so duplicate detection is testable.
  return { version: 1, features };
}

function makeDocument(overrides: Partial<EditorDocument> = {}): EditorDocument {
  return {
    version: 1,
    projectId: UUID_B,
    head: "0001",
    sourceRevision: HEX64_C,
    sourceFingerprint: HEX64_B,
    editorRevision: HEX64_A,
    scad: "wall = 4;\ncube([20, 20, wall]);\n",
    parameters: [
      { name: "wall", type: "number", initial: 4, min: 2, max: 10, step: 0.5 }
    ],
    values: { wall: 4 },
    sidecar: makeSidecar(),
    sidecarStatus: "ready",
    eligibility: [],
    ...overrides
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema version + route table
// ─────────────────────────────────────────────────────────────────────────────

describe("EDITOR_SCHEMA_VERSION and EDITOR_ROUTES", () => {
  it("freezes the schema version at 1", () => {
    expect(EDITOR_SCHEMA_VERSION).toBe(1);
  });

  it("mounts editor routes under /api/projects/:projectId/editor", () => {
    expect(EDITOR_ROUTES.get.startsWith("/projects/:projectId/editor")).toBe(true);
    expect(EDITOR_ROUTES.verify).toBe("/projects/:projectId/editor/verify");
    expect(EDITOR_ROUTES.commands).toBe("/projects/:projectId/editor/commands");
    expect(EDITOR_ROUTES.operation).toBe(
      "/projects/:projectId/editor/operations/:operationId"
    );
  });

  it("does not silently mutate API_ROUTES (wire-and-recovery §'exact additive')", () => {
    expect(Object.keys(API_ROUTES).sort()).not.toContain("editor");
    expect(API_BASE_PATH).toBe("/api");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Limits and tolerances
// ─────────────────────────────────────────────────────────────────────────────

describe("editor numeric limits", () => {
  it("freezes the label / array / radial-axis / binding-version caps", () => {
    expect(EDITOR_LABEL_MAX_CODE_POINTS).toBe(120);
    expect(EDITOR_MAX_REFERENCE_ARRAY).toBe(256);
    expect(EDITOR_RADIAL_AXIS_NORM_TOLERANCE).toBe(1e-9);
    expect(EDITOR_BINDING_VERSION_MAX).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EditorSidecar
// ─────────────────────────────────────────────────────────────────────────────

describe("parseEditorSidecar", () => {
  it("accepts a minimal sidecar with one feature", () => {
    const parsed = parseEditorSidecar(makeSidecar());
    expect(parsed.features).toHaveLength(1);
  });

  it("rejects unknown version", () => {
    const result = safeParseEditorSidecar({ version: 2, features: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("EditorSidecar");
  });

  it("rejects unknown fields (no extra metadata on sidecar)", () => {
    const result = safeParseEditorSidecar({
      version: 1,
      features: [],
      extra: true
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array features field", () => {
    const result = safeParseEditorSidecar({ version: 1, features: "nope" });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate featureIds (wire-and-recovery §'parser rules')", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([makeFeature(), makeFeature()])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe("EditorSidecar.features");
    }
  });

  it("rejects a featureId that is not a UUID", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([makeFeature({ featureId: "not-a-uuid" })])
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a slug projectId on a feature", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([makeFeature({ projectId: "hinged-box" })])
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a feature projectId that violates the safe-id rule", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([makeFeature({ projectId: "a/b" })])
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-finite Vec3 component", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([
        makeFeature({
          binding: {
            kind: "radial",
            parameter: "r",
            center: [0, 0, 0],
            axis: [Number.POSITIVE_INFINITY, 0, 0],
            parameterMeaning: "radius",
            presentation: "radius"
          }
        })
      ])
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a radial axis whose norm is outside the 1e-9 tolerance", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([
        makeFeature({
          binding: {
            kind: "radial",
            parameter: "r",
            center: [0, 0, 0],
            axis: [1, 1, 0],
            parameterMeaning: "radius",
            presentation: "radius"
          }
        })
      ])
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a radial axis with a norm within 1e-9 of 1", () => {
    // Construct a vector of norm 1 + 1e-12 — comfortably inside the tolerance.
    const axis: [number, number, number] = [1, 0, 5e-13];
    const result = safeParseEditorSidecar(
      makeSidecar([
        makeFeature({
          binding: {
            kind: "radial",
            parameter: "r",
            center: [0, 0, 0],
            axis,
            parameterMeaning: "radius",
            presentation: "radius"
          }
        })
      ])
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a label that exceeds the 120-code-point cap", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([makeFeature({ label: "x".repeat(EDITOR_LABEL_MAX_CODE_POINTS + 1) })])
    );
    expect(result.ok).toBe(false);
  });

  it("counts Unicode code points, not UTF-16 code units, for the label cap", () => {
    // Each emoji is two UTF-16 code units but a single code point. 120 emojis
    // is one code point each → should pass.
    const ok = safeParseEditorSidecar(
      makeSidecar([makeFeature({ label: "🌀".repeat(EDITOR_LABEL_MAX_CODE_POINTS) })])
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects a non-positive bindingVersion", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([makeFeature({ bindingVersion: 0 })])
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a bindingVersion that is not a safe integer", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([makeFeature({ bindingVersion: Number.MAX_SAFE_INTEGER + 1 })])
    );
    expect(result.ok).toBe(false);
  });

  it("requires confirmedBy: 'user' on ai-proposed and parser-provenance", () => {
    const ok = safeParseEditorSidecar(
      makeSidecar([
        makeFeature({
          provenance: { kind: "ai-proposed", confirmedBy: "user" }
        })
      ])
    );
    expect(ok.ok).toBe(true);

    const bad = safeParseEditorSidecar(
      makeSidecar([
        makeFeature({
          provenance: { kind: "ai-proposed", confirmedBy: "model" as never }
        })
      ])
    );
    expect(bad.ok).toBe(false);
  });

  it("rejects extra fields on manual provenance", () => {
    const result = safeParseEditorSidecar(
      makeSidecar([
        makeFeature({
          provenance: { kind: "manual", extra: true } as never
        })
      ])
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a features array that exceeds the 256 reference cap", () => {
    // The constructed ids won't all be valid UUIDs, but the parser must trip
    // the array cap before per-element UUID validation in this test's ordering.
    // Use distinct, valid UUIDs to be safe.
    const valid: EditorFeature[] = Array.from({ length: 257 }, (_, i) =>
      makeFeature({ featureId: `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}` })
    );
    const result = safeParseEditorSidecar({ version: 1, features: valid });
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EditorDocument
// ─────────────────────────────────────────────────────────────────────────────

describe("parseEditorDocument", () => {
  it("accepts a fully-populated modern document", () => {
    const parsed = parseEditorDocument(makeDocument());
    expect(parsed.version).toBe(1);
    expect(parsed.head).toBe("0001");
    expect(parsed.sidecarStatus).toBe("ready");
  });

  it("accepts a project with no history (head: null)", () => {
    const parsed = parseEditorDocument(makeDocument({ head: null }));
    expect(parsed.head).toBeNull();
  });

  it.each(VALID_PROJECT_IDS)("accepts a well-formed project id %j", (id) => {
    const result = safeParseEditorDocument(makeDocument({ projectId: id }));
    expect(result.ok).toBe(true);
  });

  it.each(INVALID_PROJECT_IDS)("rejects an invalid project id %j", (id) => {
    const result = safeParseEditorDocument(makeDocument({ projectId: id }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-hex64 sourceFingerprint", () => {
    const result = safeParseEditorDocument(
      makeDocument({ sourceFingerprint: "tooshort" })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown sidecarStatus", () => {
    const result = safeParseEditorDocument(
      makeDocument({ sidecarStatus: "uh-oh" as never })
    );
    expect(result.ok).toBe(false);
  });

  it("normalises -0 to 0 in Vec3 (canonical JSON rule)", () => {
    // Construct a binding with -0 components and verify the parsed value is 0.
    const feature = makeFeature({
      binding: {
        kind: "radial",
        parameter: "r",
        center: [-0, 0, -0],
        axis: [1, 0, 0],
        parameterMeaning: "radius",
        presentation: "radius"
      }
    });
    const parsed = parseEditorSidecar(makeSidecar([feature]));
    const radial = parsed.features[0].binding;
    if (radial.kind !== "radial") throw new Error("expected radial");
    // Object.is distinguishes -0 from 0; we want both to read as 0.
    expect(Object.is(radial.center[0], 0)).toBe(true);
    expect(Object.is(radial.center[0], -0)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EditorCommand, EditorVerifyRequest, EditorProofResponse, EditorCommitRequest
// ─────────────────────────────────────────────────────────────────────────────

describe("parseEditorCommand", () => {
  it("accepts a set-value command", () => {
    const cmd: EditorCommand = {
      kind: "set-value",
      featureId: UUID_A,
      bindingVersion: 1,
      value: 5
    };
    expect(parseEditorCommand(cmd).kind).toBe("set-value");
  });

  it("accepts a put-feature command", () => {
    const cmd: EditorCommand = { kind: "put-feature", feature: makeFeature() };
    expect(parseEditorCommand(cmd).kind).toBe("put-feature");
  });

  it("accepts a remove-feature command", () => {
    const cmd: EditorCommand = {
      kind: "remove-feature",
      featureId: UUID_A,
      bindingVersion: 1
    };
    expect(parseEditorCommand(cmd).kind).toBe("remove-feature");
  });

  it("rejects an unknown command kind", () => {
    const result = safeParseEditorCommand({ kind: "nope" });
    expect(result.ok).toBe(false);
  });

  it("rejects a set-value whose value is non-finite", () => {
    const result = safeParseEditorCommand({
      kind: "set-value",
      featureId: UUID_A,
      bindingVersion: 1,
      value: Number.POSITIVE_INFINITY
    });
    expect(result.ok).toBe(false);
  });

  it("does not coerce a string value to a number", () => {
    const result = safeParseEditorCommand({
      kind: "set-value",
      featureId: UUID_A,
      bindingVersion: 1,
      value: "5"
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseEditorVerifyRequest", () => {
  function makeVerify(overrides: Partial<EditorVerifyRequest> = {}): EditorVerifyRequest {
    return {
      version: 1,
      baseEditorRevision: HEX64_A,
      command: { kind: "set-value", featureId: UUID_A, bindingVersion: 1, value: 5 },
      intent: "edit",
      traversal: null,
      ...overrides
    };
  }

  it("accepts an edit with no traversal", () => {
    const parsed = parseEditorVerifyRequest(makeVerify());
    expect(parsed.intent).toBe("edit");
    expect(parsed.traversal).toBeNull();
  });

  it("requires traversal for undo intent", () => {
    const result = safeParseEditorVerifyRequest(
      makeVerify({ intent: "undo", traversal: null })
    );
    expect(result.ok).toBe(false);
  });

  it("requires traversal for redo intent", () => {
    const result = safeParseEditorVerifyRequest(
      makeVerify({ intent: "redo", traversal: null })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects traversal on edit intent", () => {
    const result = safeParseEditorVerifyRequest(
      makeVerify({
        intent: "edit",
        traversal: { operationId: UUID_A, direction: "undo" }
      })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects traversal on setup intent", () => {
    const result = safeParseEditorVerifyRequest(
      makeVerify({
        intent: "setup",
        traversal: { operationId: UUID_A, direction: "redo" }
      })
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a traversal whose operationId is a UUID", () => {
    const parsed = parseEditorVerifyRequest(
      makeVerify({
        intent: "undo",
        traversal: { operationId: UUID_A, direction: "undo" }
      })
    );
    expect(parsed.traversal?.direction).toBe("undo");
  });

  it("rejects a baseEditorRevision that is not lowercase 64-hex", () => {
    const result = safeParseEditorVerifyRequest(
      makeVerify({ baseEditorRevision: "tooshort" })
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseEditorProofResponse", () => {
  const good: EditorProofResponse = {
    version: 1,
    proofId: UUID_A,
    commandDigest: HEX64_A,
    baseEditorRevision: HEX64_B,
    expiresAt: ISO_NOW
  };

  it("accepts a well-formed proof response", () => {
    expect(parseEditorProofResponse(good).proofId).toBe(UUID_A);
  });

  it("rejects an uppercase hex digest (must be lowercase 64-hex)", () => {
    const result = safeParseEditorProofResponse({
      ...good,
      commandDigest: "A".repeat(64)
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-ISO-8601 expiresAt", () => {
    const result = safeParseEditorProofResponse({ ...good, expiresAt: "not-a-date" });
    expect(result.ok).toBe(false);
  });
});

describe("parseEditorCommitRequest", () => {
  it("accepts a well-formed commit request (verify + operationId + proofId)", () => {
    const req: EditorCommitRequest = {
      version: 1,
      baseEditorRevision: HEX64_A,
      command: { kind: "set-value", featureId: UUID_A, bindingVersion: 1, value: 5 },
      intent: "edit",
      traversal: null,
      operationId: UUID_A,
      proofId: UUID_B
    };
    expect(parseEditorCommitRequest(req).proofId).toBe(UUID_B);
  });

  it("rejects a missing proofId", () => {
    const result = safeParseEditorCommitRequest({
      version: 1,
      baseEditorRevision: HEX64_A,
      command: { kind: "set-value", featureId: UUID_A, bindingVersion: 1, value: 5 },
      intent: "edit",
      traversal: null,
      operationId: UUID_A
    });
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EditorReceipt and EditorOperationResponse
// ─────────────────────────────────────────────────────────────────────────────

describe("parseEditorReceipt", () => {
  const good: EditorReceipt = {
    version: 1,
    projectId: UUID_B,
    operationId: UUID_A,
    requestDigest: HEX64_A,
    baseEditorRevision: HEX64_B,
    editorRevision: HEX64_C,
    snapshotId: "0007",
    values: { wall: 5 },
    sidecarDigest: HEX64_D
  };

  it("accepts a well-formed receipt", () => {
    expect(parseEditorReceipt(good).snapshotId).toBe("0007");
  });

  it("rejects a missing snapshotId", () => {
    const result = safeParseEditorReceipt({ ...good, snapshotId: "" });
    expect(result.ok).toBe(false);
  });

  it("accepts a slug projectId", () => {
    expect(parseEditorReceipt({ ...good, projectId: "hinged-box" }).projectId).toBe(
      "hinged-box"
    );
  });

  it("rejects a projectId that violates the safe-id rule", () => {
    const result = safeParseEditorReceipt({ ...good, projectId: ".." });
    expect(result.ok).toBe(false);
  });
});

describe("parseEditorOperationResponse", () => {
  const receipt = {
    version: 1 as const,
    projectId: UUID_B,
    operationId: UUID_A,
    requestDigest: HEX64_A,
    baseEditorRevision: HEX64_B,
    editorRevision: HEX64_C,
    snapshotId: "0007",
    values: { wall: 5 },
    sidecarDigest: HEX64_D
  };

  it("parses a committed response with its receipt", () => {
    const parsed = parseEditorOperationResponse({ version: 1, state: "committed", receipt });
    expect(parsed.state).toBe("committed");
    if (parsed.state === "committed") expect(parsed.receipt.snapshotId).toBe("0007");
  });

  it("parses a definitely_not_committed response with reason 'rejected' and an ApiError", () => {
    const parsed = parseEditorOperationResponse({
      version: 1,
      state: "definitely_not_committed",
      requestDigest: HEX64_A,
      reason: "rejected",
      error: { error_code: "VALIDATION_FAILED", message: "binding refused" }
    });
    expect(parsed.state).toBe("definitely_not_committed");
    if (parsed.state === "definitely_not_committed") {
      expect(parsed.reason).toBe("rejected");
      expect(parsed.error?.error_code).toBe("VALIDATION_FAILED");
    }
  });

  it("parses a definitely_not_committed response with reason 'unclaimed' and null error", () => {
    const parsed = parseEditorOperationResponse({
      version: 1,
      state: "definitely_not_committed",
      requestDigest: null,
      reason: "unclaimed",
      error: null
    });
    expect(parsed.state).toBe("definitely_not_committed");
    if (parsed.state === "definitely_not_committed") {
      expect(parsed.error).toBeNull();
      expect(parsed.requestDigest).toBeNull();
    }
  });

  it("parses an unknown response (commit-uncertainty recovery surface)", () => {
    const parsed = parseEditorOperationResponse({
      version: 1,
      state: "unknown",
      requestDigest: null
    });
    expect(parsed.state).toBe("unknown");
  });

  it("rejects an unknown state outside the typed enum", () => {
    const result = safeParseEditorOperationResponse({
      version: 1,
      state: "pending" as never
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an error_code that is not in ERROR_CODES", () => {
    const result = safeParseEditorOperationResponse({
      version: 1,
      state: "definitely_not_committed",
      requestDigest: HEX64_A,
      reason: "rejected",
      error: { error_code: "NOT_A_REAL_CODE", message: "nope" }
    });
    expect(result.ok).toBe(false);
  });

  it.each(ERROR_CODES)("accepts error_code %s inside a definitely_not_committed response", (code) => {
    const result = safeParseEditorOperationResponse({
      version: 1,
      state: "definitely_not_committed",
      requestDigest: HEX64_A,
      reason: "rejected",
      error: { error_code: code, message: "x" }
    });
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AgentEditorContext
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAgentEditorContext", () => {
  function makeContext(overrides: Partial<AgentEditorContext> = {}): AgentEditorContext {
    return {
      version: 1,
      projectId: UUID_B,
      editorRevision: HEX64_A,
      sourceRevision: HEX64_C,
      sourceFingerprint: HEX64_B,
      sidecarStatus: "ready",
      features: [makeFeature()],
      eligibility: [] as EditorEligibility[],
      ...overrides
    };
  }

  it("accepts a populated context", () => {
    const parsed = parseAgentEditorContext(makeContext());
    expect(parsed.sidecarStatus).toBe("ready");
    expect(parsed.features).toHaveLength(1);
  });

  it("accepts an empty features array (legacy-empty sidecar)", () => {
    const parsed = parseAgentEditorContext(makeContext({ features: [] }));
    expect(parsed.features).toEqual([]);
  });

  it("rejects an unknown sidecarStatus", () => {
    const result = safeParseAgentEditorContext(
      makeContext({ sidecarStatus: "weird" as never })
    );
    expect(result.ok).toBe(false);
  });

  it.each(VALID_PROJECT_IDS)("accepts a well-formed project id %j", (id) => {
    const result = safeParseAgentEditorContext(makeContext({ projectId: id }));
    expect(result.ok).toBe(true);
  });

  it.each(INVALID_PROJECT_IDS)("rejects an invalid project id %j", (id) => {
    const result = safeParseAgentEditorContext(makeContext({ projectId: id }));
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EditorSnapshotRef (disk declaration)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseEditorSnapshotRef", () => {
  it("accepts a well-formed descriptor", () => {
    const parsed = parseEditorSnapshotRef({
      version: 1,
      file: "editor.json",
      sha256: HEX64_A
    });
    expect(parsed.file).toBe("editor.json");
  });

  it("rejects a file name other than 'editor.json'", () => {
    const result = safeParseEditorSnapshotRef({
      version: 1,
      file: "sidecar.json",
      sha256: HEX64_A
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-hex sha256", () => {
    const result = safeParseEditorSnapshotRef({
      version: 1,
      file: "editor.json",
      sha256: "not-a-hash"
    });
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error shape
// ─────────────────────────────────────────────────────────────────────────────

describe("EditorProtocolError", () => {
  it("is a named Error subclass with a path", () => {
    const result = safeParseEditorSidecar({ version: 2, features: [] });
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBeInstanceOf(EditorProtocolError);
    expect(result.error.name).toBe("EditorProtocolError");
    expect(result.error.path).toBe("EditorSidecar");
  });

  it("rejects a clearly-wrong wire payload with a precise path", () => {
    const result = safeParseEditorDocument({ version: 1, projectId: ".." });
    if (result.ok) throw new Error("expected failure");
    expect(result.error.path).toBe("EditorDocument.projectId");
  });
});
