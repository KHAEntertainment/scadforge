// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ABORTED_REPLAY_MESSAGE,
  DEFAULT_VIEWS,
  __setFaultActionForTests,
  canonicalSidecar,
  commandDigest,
  createSnapshotLocked,
  editorRevision,
  initProject,
  listSnapshots,
  lookupClaimLocked,
  mergeParamsAtomic,
  persistProofRecord,
  rootModelPath,
  sidecarDigest,
  sourceFingerprint,
  withRecoveredProject,
  writeSidecarLocked
} from "@scadforge/scad-core";
import type { ProofRecord, RenderResult, RenderedView, SyntaxCheckResult } from "@scadforge/scad-core";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import type {
  EditorCommand,
  EditorCommitRequest,
  EditorFeature,
  EditorIntent,
  EditorSidecar,
  EditorTraversal,
  ParamValues,
  ProjectManifest
} from "@scadforge/protocol";
import { RouteError } from "./errors.js";
import { assertCompleteBuildRender, coherentSourceState, compileProposedSource, createScadCoreApi } from "./scad-core-impl.js";
import { createServerRuntime, type ServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

function view(view: RenderedView["view"], ok: boolean): RenderedView {
  return {
    view,
    ok,
    path: ok ? `/tmp/${view}.png` : null,
    camera: "",
    projection: "ortho",
    imgsize: [256, 256],
    bytes: ok ? 1 : null,
    render_ms: 1,
    stderr: ok ? null : `${view} failed`
  };
}

describe("studio build backend guards", () => {
  it("rejects a partial render set before attachments can be persisted", () => {
    const result: RenderResult = {
      ok: false,
      views: DEFAULT_VIEWS.map((name, index) => view(name, index !== 1)),
      total_ms: 2,
      error_code: "RENDER_FAILED",
      message: "render_views: 1 of 4 view(s) failed"
    };

    expect(() => assertCompleteBuildRender(result)).toThrowError(
      expect.objectContaining({ code: "RENDER_FAILED" })
    );
  });

  it("accepts only a complete successful render set", () => {
    const result: RenderResult = { ok: true, views: DEFAULT_VIEWS.map((name) => view(name, true)), total_ms: 2 };
    expect(() => assertCompleteBuildRender(result)).not.toThrow();
  });

  it("propagates Customizer export failures instead of returning an empty schema", async () => {
    const runtime = { libraryPaths: [] } as unknown as ServerRuntime;
    const syntax: SyntaxCheckResult = { ok: true, errors: [], warnings: [], ms: 1 };

    await expect(
      compileProposedSource(runtime, "cube([1, 1, 1]);\n", {
        syntaxCheck: async () => syntax,
        paramExport: async () => {
          throw new RouteError("RENDER_FAILED", "param export unavailable");
        }
      })
    ).rejects.toMatchObject({ code: "RENDER_FAILED", message: "param export unavailable" });
  });
});

// ── Issue #73 AC9: projectResponse coherence under a concurrent slow writer ──
//
// No OpenSCAD/Docker involved -- `getProject` never invokes the CLI, so this
// is a plain filesystem-timing test.
describe("projectResponse coherence under a concurrent slow writer (Issue #73 AC9)", () => {
  let root: string;
  const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scadforge-project-response-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("every concurrent getProject read is internally coherent -- never a head from one write paired with scad/params from another", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    const OLD_CONTENT = "cube([10,10,10]);\n";
    const NEW_CONTENT = "cube([20,20,20]);\n";
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: OLD_CONTENT, params: {} });

    const api = createScadCoreApi(runtime);

    // A slow writer: holds the recovery boundary for 60ms while producing a
    // brand-new snapshot with different content AND params -- long enough
    // that several concurrent reads are guaranteed to land squarely inside
    // its critical section if the boundary did not serialize them.
    const slowWrite = mergeParamsAtomic(dir, { tag: "new" }, async (merged, ctx) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      return createSnapshotLocked(ctx, {
        content: NEW_CONTENT,
        params: merged,
        message: "slow concurrent write",
        origin: "manual",
        pass: null
      });
    });

    // Fire a burst of reads that overlap the slow writer's critical section.
    const reads = Array.from({ length: 8 }, () => api.getProject("p"));

    const [, ...results] = await Promise.all([slowWrite, ...reads]);

    for (const response of results) {
      expect(response.head).not.toBeNull();
      if (response.head!.id === "0001") {
        // Observed strictly BEFORE the slow write committed -- every field
        // must agree with the OLD state, never a partial peek at the new one.
        expect(response.scad).toBe(OLD_CONTENT);
        expect(response.params.tag).toBeUndefined();
      } else {
        // Observed strictly AFTER the slow write committed.
        expect(response.head!.id).toBe("0002");
        expect(response.scad).toBe(NEW_CONTENT);
        expect(response.params.tag).toBe("new");
      }
    }
  });
});

// ── coherentSourceState carries the editor sidecar (Issue #87 / S3-B ticket B3, AC9) ──
//
// No wire response changes -- this only proves the INTERNAL coherent-read
// result carries the sidecar fields B5/B6/B7 will consume.
describe("coherentSourceState internal sidecar fields (Issue #87)", () => {
  let root: string;
  const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scadforge-coherent-source-state-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function feature(overrides: Partial<EditorFeature> = {}): EditorFeature {
    return {
      featureId: randomUUID(),
      label: "Width",
      projectId: randomUUID(),
      createdAtRevision: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      bindingVersion: 1,
      provenance: { kind: "manual" },
      binding: { kind: "linear", parameter: "width", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
      ...overrides
    };
  }

  it("a brand-new project (S3-modern from its first snapshot) reads ready with an empty feature list and a non-null editor revision", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const state = await coherentSourceState(dir);

    expect(state.sidecarStatus).toBe("ready");
    expect(state.sidecarFeatures).toEqual([]);
    expect(state.sidecarDigest).not.toBeNull();
    expect(state.editorRevision).toBe(editorRevision(state.revision, state.sidecarDigest!));
  });

  it("a sidecar write changes editorRevision without changing revision (source untouched)", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const before = await coherentSourceState(dir);
    const sidecar: EditorSidecar = { version: 1, features: [feature()] };
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, sidecar));
    const after = await coherentSourceState(dir);

    expect(after.revision).toBe(before.revision);
    expect(after.editorRevision).not.toBe(before.editorRevision);
    expect(after.sidecarFeatures.map((f) => f.featureId)).toEqual([sidecar.features[0].featureId]);
  });
});

// ── submitEditorCommand integration (S3-B ticket B6, Issue #98) ─────────────
//
// Against the REAL store (createScadCoreApi(runtime), a real temp
// .scadforge/ tree) with a MOCKED engine: submitEditorCommand itself never
// touches OpenSCAD at all -- the proof it trusts was already rendered by an
// earlier /verify call, entirely outside any lock (see commands.ts's module
// header for exactly which checks rest on the proof). These tests persist a
// hand-built ProofRecord directly via persistProofRecord instead of driving
// a real render through verifyEditorCommand/runProbe -- that IS the
// "mocked engine" the ticket's integration-test AC asks for; nothing here
// touches Docker.
describe("submitEditorCommand integration (S3-B ticket B6, Issue #98)", () => {
  let root: string;
  const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scadforge-editor-commit-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Strips `editor_store_version` from project.json, simulating a genuinely pre-S3 (legacy) project -- initProject always makes new projects modern, so this downgrades one after the fact. */
  async function makeLegacy(dir: string): Promise<void> {
    const manifestPath = join(dir, PROJECT_LAYOUT.metaDir, PROJECT_LAYOUT.projectFile);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProjectManifest;
    delete manifest.editor_store_version;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  function historySidecarPath(dir: string, snapshotId: string): string {
    return join(dir, PROJECT_LAYOUT.metaDir, PROJECT_LAYOUT.historyDir, snapshotId, "editor.json");
  }

  /** Persists a proof record matching exactly what a real /verify call would have produced for this command. */
  async function persistFakeProof(
    dir: string,
    input: {
      projectId: string;
      baseEditorRevision: string;
      command: EditorCommand;
      intent: EditorIntent;
      traversal: EditorTraversal | null;
      authoritativeParams: ParamValues;
      candidateParams: ParamValues | null;
    }
  ): Promise<string> {
    const proofId = randomUUID();
    const digest = commandDigest({
      version: 1,
      projectId: input.projectId,
      baseEditorRevision: input.baseEditorRevision,
      command: input.command,
      intent: input.intent,
      traversal: input.traversal
    });
    const record: ProofRecord = {
      version: 1,
      proofId,
      projectId: input.projectId,
      baseEditorRevision: input.baseEditorRevision,
      sourceFingerprint: sourceFingerprint("cube(1);\n"),
      authoritativeParams: input.authoritativeParams,
      commandDigest: digest,
      command: input.command,
      intent: input.intent,
      traversal: input.traversal,
      candidateParams: input.candidateParams,
      candidateEqualsBaseline: input.command.kind === "put-feature" ? true : input.command.kind === "set-value" ? false : null,
      samples: [],
      recognizerVersion: "test-mock",
      engineImage: "test-mock",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      success: true
    };
    await persistProofRecord(dir, record);
    return proofId;
  }

  function fixtureFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
    return {
      featureId: randomUUID(),
      label: "Wall",
      projectId: "p",
      // Placeholder 64-hex, not "" -- the wire parser's expectHex64 rejects
      // an empty string on READ (readSidecarLocked runs the real
      // parseEditorSidecar), which would otherwise surface as a CORRUPT
      // sidecar rather than "ready", however irrelevant these two fields are
      // to the specific test seeding this fixture directly.
      createdAtRevision: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      bindingVersion: 1,
      provenance: { kind: "manual" },
      binding: { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
      ...overrides
    };
  }

  it("a put-feature on a legacy project flips the marker and makes the document ready", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 2 } });
    await makeLegacy(dir);

    const before = await coherentSourceState(dir);
    expect(before.sidecarStatus).toBe("legacy-empty");
    const baseRevision = before.editorRevision ?? before.revision; // story rule: falls back to sourceRevision

    const feature = fixtureFeature({ projectId: "p", createdAtRevision: baseRevision, sourceFingerprint: sourceFingerprint("cube(1);\n") });
    const command: EditorCommand = { kind: "put-feature", feature };
    const proofId = await persistFakeProof(dir, {
      projectId: "p",
      baseEditorRevision: baseRevision,
      command,
      intent: "setup",
      traversal: null,
      authoritativeParams: before.params,
      candidateParams: before.params
    });

    const api = createScadCoreApi(runtime);
    const receipt = await api.submitEditorCommand("p", {
      version: 1,
      baseEditorRevision: baseRevision,
      command,
      intent: "setup",
      traversal: null,
      operationId: randomUUID(),
      proofId
    });

    expect(receipt.values).toEqual({ wall: 2 });
    const after = await coherentSourceState(dir);
    expect(after.sidecarStatus).toBe("ready");
    expect(after.sidecarFeatures).toHaveLength(1);
    expect(after.sidecarFeatures[0]!.featureId).toBe(feature.featureId);
  });

  it("a set-value produces one snapshot whose editor.json digest equals receipt.sidecarDigest", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p2");
    await initProject(dir, { id: "p2", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 2 } });
    const feature = fixtureFeature({ projectId: "p2" });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [feature] }));

    const api = createScadCoreApi(runtime);
    const state = await coherentSourceState(dir);
    const command: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const proofId = await persistFakeProof(dir, {
      projectId: "p2",
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      authoritativeParams: state.params,
      candidateParams: { ...state.params, wall: 9 }
    });
    const receipt = await api.submitEditorCommand("p2", {
      version: 1,
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      operationId: randomUUID(),
      proofId
    });

    expect(receipt.values).toEqual({ wall: 9 });
    const snapshotSidecarBytes = await readFile(historySidecarPath(dir, receipt.snapshotId), "utf8");
    const recomputedDigest = sidecarDigest(canonicalSidecar(JSON.parse(snapshotSidecarBytes)));
    expect(recomputedDigest).toBe(receipt.sidecarDigest);
  });

  it("undo then redo of a set-value edit produces two more snapshots and ends at the post-edit values", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p3");
    await initProject(dir, { id: "p3", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 2 } });
    const feature = fixtureFeature({ projectId: "p3" });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [feature] }));
    const api = createScadCoreApi(runtime);

    // Original edit: wall 2 -> 9.
    const editOperationId = randomUUID();
    const state0 = await coherentSourceState(dir);
    const editCommand: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const editProof = await persistFakeProof(dir, {
      projectId: "p3",
      baseEditorRevision: state0.editorRevision!,
      command: editCommand,
      intent: "edit",
      traversal: null,
      authoritativeParams: state0.params,
      candidateParams: { ...state0.params, wall: 9 }
    });
    const editReceipt = await api.submitEditorCommand("p3", {
      version: 1,
      baseEditorRevision: state0.editorRevision!,
      command: editCommand,
      intent: "edit",
      traversal: null,
      operationId: editOperationId,
      proofId: editProof
    });
    expect(editReceipt.values).toEqual({ wall: 9 });

    // Undo: wall 9 -> 2, referencing the original edit's operation id.
    const state1 = await coherentSourceState(dir);
    const undoCommand: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 2 };
    const undoTraversal: EditorTraversal = { operationId: editOperationId, direction: "undo" };
    const undoProof = await persistFakeProof(dir, {
      projectId: "p3",
      baseEditorRevision: state1.editorRevision!,
      command: undoCommand,
      intent: "undo",
      traversal: undoTraversal,
      authoritativeParams: state1.params,
      candidateParams: { ...state1.params, wall: 2 }
    });
    const undoReceipt = await api.submitEditorCommand("p3", {
      version: 1,
      baseEditorRevision: state1.editorRevision!,
      command: undoCommand,
      intent: "undo",
      traversal: undoTraversal,
      operationId: randomUUID(),
      proofId: undoProof
    });
    expect(undoReceipt.values).toEqual({ wall: 2 });
    expect(undoReceipt.snapshotId).not.toBe(editReceipt.snapshotId);

    // Redo: wall 2 -> 9, referencing the SAME original edit's operation id.
    const state2 = await coherentSourceState(dir);
    const redoCommand: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const redoTraversal: EditorTraversal = { operationId: editOperationId, direction: "redo" };
    const redoProof = await persistFakeProof(dir, {
      projectId: "p3",
      baseEditorRevision: state2.editorRevision!,
      command: redoCommand,
      intent: "redo",
      traversal: redoTraversal,
      authoritativeParams: state2.params,
      candidateParams: { ...state2.params, wall: 9 }
    });
    const redoReceipt = await api.submitEditorCommand("p3", {
      version: 1,
      baseEditorRevision: state2.editorRevision!,
      command: redoCommand,
      intent: "redo",
      traversal: redoTraversal,
      operationId: randomUUID(),
      proofId: redoProof
    });

    // Two MORE snapshots beyond the original edit's one, ending back at the
    // post-edit values (undo and redo cancel out).
    expect(redoReceipt.values).toEqual({ wall: 9 });
    expect(redoReceipt.snapshotId).not.toBe(undoReceipt.snapshotId);
    expect(redoReceipt.snapshotId).not.toBe(editReceipt.snapshotId);
  });

  it("an external PUT /params write between proof and commit makes the commit return CONFLICT", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p4");
    await initProject(dir, { id: "p4", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 2 } });
    const feature = fixtureFeature({ projectId: "p4" });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [feature] }));
    const api = createScadCoreApi(runtime);

    const state = await coherentSourceState(dir);
    const command: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const proofId = await persistFakeProof(dir, {
      projectId: "p4",
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      authoritativeParams: state.params,
      candidateParams: { ...state.params, wall: 9 }
    });

    // An EXTERNAL write (a real REST caller's PUT /params) lands between the
    // proof and the commit -- advances the editor revision out from under
    // the proof's pinned baseEditorRevision.
    await api.updateParams("p4", { values: { wall: 3 }, snapshot: false });

    await expect(
      api.submitEditorCommand("p4", {
        version: 1,
        baseEditorRevision: state.editorRevision!,
        command,
        intent: "edit",
        traversal: null,
        operationId: randomUUID(),
        proofId
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("two concurrent identical requests produce exactly one snapshot", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p5");
    await initProject(dir, { id: "p5", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 2 } });
    const feature = fixtureFeature({ projectId: "p5" });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [feature] }));
    const api = createScadCoreApi(runtime);

    const state = await coherentSourceState(dir);
    const command: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const proofId = await persistFakeProof(dir, {
      projectId: "p5",
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      authoritativeParams: state.params,
      candidateParams: { ...state.params, wall: 9 }
    });
    const operationId = randomUUID();
    const request: EditorCommitRequest = {
      version: 1,
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      operationId,
      proofId
    };

    const [a, b] = await Promise.all([api.submitEditorCommand("p5", request), api.submitEditorCommand("p5", request)]);
    expect(a).toEqual(b); // the SAME receipt, never a second snapshot

    const stateAfter = await coherentSourceState(dir);
    expect(stateAfter.head).toBe(a.snapshotId);
  });

  // R1 regression (QA finding on PR #108, Medium, made a merge requirement by
  // the Tech Lead): the claim's `accepted` before/after record is captured at
  // COMMIT TIME from the live root state -- never derived later by diffing
  // the accepted snapshot against its parent. A `snapshot:false` params write
  // (the PUT /params path) between the parent snapshot and an editor commit
  // is exactly the case a diff-based derivation would get wrong: the parent
  // snapshot's own params never see that intervening write, so undo would
  // wrongly restore the PARENT SNAPSHOT'S value instead of the TRUE
  // pre-edit live value.
  it("undo after an intervening snapshot:false params write restores the TRUE pre-edit value, not the parent snapshot's", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p6");
    // Parent (and only) snapshot 0001 captures wall = 1 (v1).
    await initProject(dir, { id: "p6", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 1 } });
    const feature = fixtureFeature({ projectId: "p6" });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [feature] }));
    const api = createScadCoreApi(runtime);

    // A snapshot-free write (PUT /params, snapshot:false) sets wall = 2 (v2)
    // WITHOUT creating a new snapshot -- 0001 still says wall = 1.
    await api.updateParams("p6", { values: { wall: 2 }, snapshot: false });
    const stateAfterExternalWrite = await coherentSourceState(dir);
    expect(stateAfterExternalWrite.params.wall).toBe(2);
    expect(await listSnapshots(dir)).toHaveLength(1); // still just the initial snapshot

    // Edit: wall 2 -> 9 (v2 -> v3).
    const editOperationId = randomUUID();
    const editCommand: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const editProof = await persistFakeProof(dir, {
      projectId: "p6",
      baseEditorRevision: stateAfterExternalWrite.editorRevision!,
      command: editCommand,
      intent: "edit",
      traversal: null,
      authoritativeParams: stateAfterExternalWrite.params,
      candidateParams: { ...stateAfterExternalWrite.params, wall: 9 }
    });
    const editReceipt = await api.submitEditorCommand("p6", {
      version: 1,
      baseEditorRevision: stateAfterExternalWrite.editorRevision!,
      command: editCommand,
      intent: "edit",
      traversal: null,
      operationId: editOperationId,
      proofId: editProof
    });
    expect(editReceipt.values).toEqual({ wall: 9 });

    // The committed claim's own before/after record holds the TRUE live
    // before-value (2), not the parent snapshot's (1).
    const editClaim = await withRecoveredProject(dir, (ctx) => lookupClaimLocked(ctx, editOperationId));
    expect(editClaim).toMatchObject({
      kind: "committed",
      accepted: { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, parameter: "wall", beforeValue: 2, afterValue: 9 }
    });

    // Undo must restore wall = 2 (the TRUE pre-edit value) -- a diff against
    // the parent snapshot would wrongly give wall = 1.
    const stateAfterEdit = await coherentSourceState(dir);
    const undoCommand: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 2 };
    const undoTraversal: EditorTraversal = { operationId: editOperationId, direction: "undo" };
    const undoProof = await persistFakeProof(dir, {
      projectId: "p6",
      baseEditorRevision: stateAfterEdit.editorRevision!,
      command: undoCommand,
      intent: "undo",
      traversal: undoTraversal,
      authoritativeParams: stateAfterEdit.params,
      candidateParams: { ...stateAfterEdit.params, wall: 2 }
    });
    const undoReceipt = await api.submitEditorCommand("p6", {
      version: 1,
      baseEditorRevision: stateAfterEdit.editorRevision!,
      command: undoCommand,
      intent: "undo",
      traversal: undoTraversal,
      operationId: randomUUID(),
      proofId: undoProof
    });
    expect(undoReceipt.values).toEqual({ wall: 2 }); // NOT { wall: 1 }

    // Redo returns to wall = 9.
    const stateAfterUndo = await coherentSourceState(dir);
    const redoCommand: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const redoTraversal: EditorTraversal = { operationId: editOperationId, direction: "redo" };
    const redoProof = await persistFakeProof(dir, {
      projectId: "p6",
      baseEditorRevision: stateAfterUndo.editorRevision!,
      command: redoCommand,
      intent: "redo",
      traversal: redoTraversal,
      authoritativeParams: stateAfterUndo.params,
      candidateParams: { ...stateAfterUndo.params, wall: 9 }
    });
    const redoReceipt = await api.submitEditorCommand("p6", {
      version: 1,
      baseEditorRevision: stateAfterUndo.editorRevision!,
      command: redoCommand,
      intent: "redo",
      traversal: redoTraversal,
      operationId: randomUUID(),
      proofId: redoProof
    });
    expect(redoReceipt.values).toEqual({ wall: 9 });
  });

  // ── "after-claim" fault point (Issue #111) ──────────────────────────────
  //
  // B4 added the "after-claim" fault point inside the now-deleted
  // `commitWithClaimLocked` (B6's originally-planned future seam), but B6's
  // real `submitEditorCommand` never routed through it, so the crash window
  // "claim durable, no staging transaction started" was unreachable on the
  // product path. `submitEditorCommand` now fires `faultPoint("after-claim")`
  // itself, right after `reserveClaimLocked` returns a genuinely NEW
  // reservation. These tests drive that fault on the REAL path -- in-process,
  // via `__setFaultActionForTests` swapping the default self-`SIGKILL` for a
  // throwing stand-in (re-exported from `@scadforge/scad-core` for exactly
  // this purpose).
  it("fires \"after-claim\" on the REAL submitEditorCommand path for a genuinely new reservation, and recovers the claim to aborted", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p7");
    await initProject(dir, { id: "p7", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 2 } });
    const feature = fixtureFeature({ projectId: "p7" });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [feature] }));
    const api = createScadCoreApi(runtime);

    const state = await coherentSourceState(dir);
    const command: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const proofId = await persistFakeProof(dir, {
      projectId: "p7",
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      authoritativeParams: state.params,
      candidateParams: { ...state.params, wall: 9 }
    });
    const operationId = randomUUID();
    const request: EditorCommitRequest = {
      version: 1,
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      operationId,
      proofId
    };
    const snapshotCountBefore = (await listSnapshots(dir)).length;

    process.env.SCADFORGE_FAULT_POINT = "after-claim";
    __setFaultActionForTests(() => {
      throw new Error("simulated crash: after-claim");
    });
    try {
      // The fault fires the instant the reservation is durable -- before any
      // proof lookup or staging -- so this always throws the same simulated
      // crash, never a validation/proof-shaped rejection.
      await expect(api.submitEditorCommand("p7", request)).rejects.toThrow(/simulated crash: after-claim/);

      // Nothing durable happened beyond the reservation itself: no new
      // snapshot, root model untouched. (The staging directory and pending
      // marker are scad-core-internal state, already covered directly by
      // transaction.ts's own crash-table tests; this proves the REAL,
      // previously-unreachable path drives the identical recovery contract.)
      expect(await listSnapshots(dir)).toHaveLength(snapshotCountBefore);
      expect(await readFile(rootModelPath(dir), "utf8")).toBe("cube(1);\n");

      // The NEXT boundary entry recovers the orphaned pending claim to
      // aborted (crash-table row 1) -- `getEditorOperation` runs its own
      // `withRecoveredProject`, so `recover()` runs automatically before this
      // lookup executes.
      const looked = await api.getEditorOperation("p7", operationId);
      expect(looked).toMatchObject({ state: "definitely_not_committed", reason: "aborted" });

      // Re-sending the IDENTICAL request now gets the aborted-replay
      // CONFLICT, never a fresh reservation -- `reserveClaimLocked` returns
      // `same-request` (same digest) with an `aborted` terminal, which
      // `submitEditorCommand` maps to `ABORTED_REPLAY_MESSAGE` WITHOUT ever
      // reaching the fault-point call again (that branch returns/throws
      // before the "reserved.kind === 'reserved'" fallthrough).
      await expect(api.submitEditorCommand("p7", request)).rejects.toMatchObject({
        code: "CONFLICT",
        message: ABORTED_REPLAY_MESSAGE
      });
    } finally {
      delete process.env.SCADFORGE_FAULT_POINT;
      __setFaultActionForTests(null);
    }
  });

  it("does not fire \"after-claim\" on a same-request replay of an already-committed operation -- proves the fault fires only on a NEW reservation", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p8");
    await initProject(dir, { id: "p8", name: "n", provider: providerConfig, content: "cube(1);\n", params: { wall: 2 } });
    const feature = fixtureFeature({ projectId: "p8" });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [feature] }));
    const api = createScadCoreApi(runtime);

    const state = await coherentSourceState(dir);
    const command: EditorCommand = { kind: "set-value", featureId: feature.featureId, bindingVersion: 1, value: 9 };
    const proofId = await persistFakeProof(dir, {
      projectId: "p8",
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      authoritativeParams: state.params,
      candidateParams: { ...state.params, wall: 9 }
    });
    const request: EditorCommitRequest = {
      version: 1,
      baseEditorRevision: state.editorRevision!,
      command,
      intent: "edit",
      traversal: null,
      operationId: randomUUID(),
      proofId
    };

    // Commit normally FIRST, fault disarmed.
    const firstReceipt = await api.submitEditorCommand("p8", request);

    // NOW arm the fault and re-send the IDENTICAL request. A same-request
    // replay of an already-committed operation returns early (`reserved.kind
    // === "same-request"` with `terminal.kind === "committed"`), which is
    // BEFORE the "reserved.kind === 'reserved'" fallthrough that fires the
    // fault point -- so this must return the cached receipt normally, never
    // throw the armed fault's stand-in.
    process.env.SCADFORGE_FAULT_POINT = "after-claim";
    __setFaultActionForTests(() => {
      throw new Error("must never fire on an already-committed replay");
    });
    try {
      const replay = await api.submitEditorCommand("p8", request);
      expect(replay).toEqual(firstReceipt);
    } finally {
      delete process.env.SCADFORGE_FAULT_POINT;
      __setFaultActionForTests(null);
    }
  });
});
