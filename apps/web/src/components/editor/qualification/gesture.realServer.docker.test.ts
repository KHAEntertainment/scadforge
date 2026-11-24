// SPDX-License-Identifier: Apache-2.0
//
// @docker — S3-C C5 (Issue #137, Stage 1): the criterion-1 cases that need a
// REAL GESTURE, against the REAL server.
//
// @docker — because a gesture is a `set-value`, and a `set-value`'s proof
// renders real samples through the pinned OpenSCAD image
// (`packages/scad-core/src/editor/proof.ts`). The verify route is used for
// EVERY proof here (Tech-Lead condition 3): this file never mints a proof in
// process. The geometry is the repository's clamp fixture, whose linear wall
// binding is already proven by
// `packages/scad-core/src/editor/proof.docker.test.ts` ("clamp: linear wall
// binding (scale-2, centered)"), so these proofs are the real thing.
//
// WHAT THE TEST PLAYS THE HOST (Tech-Lead condition 4): where `App` /
// `useEditorSession` would re-read the editor document and call
// `notifyDocumentRevision` or set the guard inputs, this file does the same
// thing — always from a real server read.
//
// THE THREE `mid_gesture` CASES move a different part of the editor's
// authority tuple between `propose` and `finalize`, so each is refused for
// its own reason:
//  - source change  → the model's source text moves;
//  - schema change  → the authoritative parameter set moves;
//  - binding change → the sidecar's binding moves (and the SOURCE side does
//    not — the case asserts that, so it is provably a binding change).

import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EditorProofResponse } from "@scadforge/protocol";
import {
  CLAMP_PARAMS,
  CLAMP_WALL_FEATURE_ID,
  assertServerBuilt,
  clampWallFeature,
  createChildTracker,
  createClampProject,
  createHost,
  createInterceptedFetch,
  createProjectsDir,
  disposeHost,
  HOOK_TIMEOUT_MS,
  eligibilityOf,
  readEditorDocument,
  seedSidecar,
  snapshotCountOf,
  startServerChild,
  verifySetValue,
  writePreviewSample,
  type ChildTracker,
  type InterceptedFetch,
  type QualificationHost,
  type ServerChildHandle,
  type TempProjectsDir
} from "./realServerHarness.js";
import { createInMemoryBroadcastChannelFactory } from "../controller/testDoubles.js";

/** Same probe scad-core's own `test-support/docker-available.ts` uses. */
function dockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const CANDIDATE = 5;

/** A REAL gesture: the proof comes from the real verify route, then `begin` → `propose`. */
async function beginTypedGesture(
  host: QualificationHost,
  options: { featureId: string; bindingVersion: number; baseValue: number; candidateValue: number }
): Promise<EditorProofResponse> {
  const document = await readEditorDocument(host.api, host.projectId);
  const proof = await verifySetValue(host.api, host.projectId, {
    baseEditorRevision: document.editorRevision,
    featureId: options.featureId,
    bindingVersion: options.bindingVersion,
    value: options.candidateValue
  });
  const began = host.controller.begin({
    featureId: options.featureId,
    bindingVersion: options.bindingVersion,
    baseEditorRevision: document.editorRevision,
    sourceFingerprint: document.sourceFingerprint,
    sidecarStatus: document.sidecarStatus,
    eligibility: eligibilityOf(document, options.featureId),
    freshProof: proof,
    baseValue: options.baseValue
  });
  expect(began.ok).toBe(true);
  const proposed = host.controller.propose(options.candidateValue, "typed");
  expect(proposed.ok).toBe(true);
  expect(host.controller.state().kind).toBe("preview-pending");
  return proof;
}

let tracker: ChildTracker;
let server: ServerChildHandle;
let projects: TempProjectsDir;
let wire: InterceptedFetch;

beforeAll(async () => {
  await assertServerBuilt();
});

beforeEach(async () => {
  tracker = createChildTracker();
  projects = await createProjectsDir();
  server = await startServerChild(tracker, projects.dir);
  wire = createInterceptedFetch();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  // F7: the temp directory is removed on EVERY path — a child that exited
  // non-zero makes killAll() throw, and the directory must not be left on
  // disk because of it. The killAll() error still fails the hook.
  try {
    await tracker.killAll();
  } finally {
    await projects.cleanup();
  }
}, HOOK_TIMEOUT_MS);

describe.skipIf(!dockerAvailable())("@docker C5 controller qualification against the real server (criterion 1, gesture cases)", () => {
  it("integration_cancel_before_submit_writes_nothing", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-cancel");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await verifySetValue(host.api, project.projectId, {
        baseEditorRevision: document.editorRevision,
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        value: CANDIDATE
      });
      const began = host.controller.begin({
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        baseEditorRevision: document.editorRevision,
        sourceFingerprint: document.sourceFingerprint,
        sidecarStatus: document.sidecarStatus,
        eligibility: eligibilityOf(document, CLAMP_WALL_FEATURE_ID),
        freshProof: proof,
        baseValue: CLAMP_PARAMS.wall
      });
      expect(began.ok).toBe(true);
      expect(host.controller.propose(CANDIDATE, "typed").ok).toBe(true);
      expect(host.controller.state().kind).toBe("preview-pending");

      const before = await snapshotCountOf(project.dir);

      // Escape, mid-gesture.
      host.controller.cancel("escape");

      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().entries).toHaveLength(0);
      // NOTHING was written: no command ever reached the wire.
      expect(wire.callsMatching((url, method) => method === "POST" && url.includes("/editor/commands"))).toHaveLength(0);
      expect(await snapshotCountOf(project.dir)).toBe(before);
    } finally {
      disposeHost(host);
    }
  }, 120000);

  it("integration_source_change_mid_gesture_invalidates_controller", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-source-change");

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await beginTypedGesture(host, {
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        baseValue: CLAMP_PARAMS.wall,
        candidateValue: CANDIDATE
      });

      // The SOURCE moves, mid-gesture, through the real route.
      const source = await host.api.getSource(project.projectId);
      await host.api.updateSource(project.projectId, {
        scad: `${source.scad}\n// touched mid-gesture\n`,
        base_revision: source.revision
      });
      const afterChange = await readEditorDocument(host.api, project.projectId);
      expect(afterChange.sourceRevision).not.toBe(document.sourceRevision);

      const before = await snapshotCountOf(project.dir);

      // The gesture is finalized against the now-stale base.
      writePreviewSample(host.controller, CANDIDATE);
      const result = await host.controller.finalize(proof);

      // THE OBSERVABLE: the real server refused the stale commit with a
      // CONFLICT; the client reported it as a definite rejection; the
      // controller went back to idle with no log entry; nothing was written.
      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("unreachable");
      expect(result.reason).toBe("rejected");
      expect(result.error?.error_code).toBe("CONFLICT");
      expect(host.conflicts).toEqual([project.projectId]);
      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().entries).toHaveLength(0);
      expect(await snapshotCountOf(project.dir)).toBe(before);
    } finally {
      disposeHost(host);
    }
  }, 120000);

  it("integration_schema_change_mid_gesture_invalidates_controller", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-schema-change");

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await beginTypedGesture(host, {
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        baseValue: CLAMP_PARAMS.wall,
        candidateValue: CANDIDATE
      });

      // The parameter DEFINITION moves, mid-gesture, through the real source
      // route: `pipe_dia`'s Customizer range changes its step. This is a
      // SCHEMA change, not a value change — the definitions themselves are
      // different afterwards.
      const source = await host.api.getSource(project.projectId);
      const changedSource = source.scad.replace(
        /pipe_dia = 32;(\s*)\/\/ \[10:1:80\]/,
        "pipe_dia = 32;$1// [10:2:80]"
      );
      expect(changedSource).not.toBe(source.scad);
      await host.api.updateSource(project.projectId, { scad: changedSource, base_revision: source.revision });

      const afterChange = await readEditorDocument(host.api, project.projectId);
      // The definitions really changed.
      expect(afterChange.parameters).not.toEqual(document.parameters);
      expect(document.parameters.find((p) => p.name === "pipe_dia")?.step).toBe(1);
      expect(afterChange.parameters.find((p) => p.name === "pipe_dia")?.step).toBe(2);
      // The gesture's own parameter did not move.
      expect(afterChange.values.wall).toBe(CLAMP_PARAMS.wall);
      expect(afterChange.sourceRevision).not.toBe(document.sourceRevision);

      const before = await snapshotCountOf(project.dir);

      writePreviewSample(host.controller, CANDIDATE);
      const result = await host.controller.finalize(proof);

      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("unreachable");
      expect(result.error?.error_code).toBe("CONFLICT");
      expect(host.conflicts).toEqual([project.projectId]);
      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().entries).toHaveLength(0);
      expect(await snapshotCountOf(project.dir)).toBe(before);
    } finally {
      disposeHost(host);
    }
  }, 120000);

  it("integration_params_value_change_mid_gesture_invalidates_controller", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-params-value-change");

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await beginTypedGesture(host, {
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        baseValue: CLAMP_PARAMS.wall,
        candidateValue: CANDIDATE
      });

      // The AUTHORITATIVE PARAMETER SET moves, mid-gesture, through the real
      // params route. (`width`, not the parameter the gesture touches: the
      // authority moved, the gesture's own subject did not.) This is a VALUE
      // change — the parameter definitions are untouched; the schema change
      // is its own case above.
      await host.api.updateParams(project.projectId, { values: { width: CLAMP_PARAMS.width + 1 } });
      const afterChange = await readEditorDocument(host.api, project.projectId);
      expect(afterChange.sourceRevision).not.toBe(document.sourceRevision);
      expect(afterChange.values.width).toBe(CLAMP_PARAMS.width + 1);
      expect(afterChange.values.wall).toBe(CLAMP_PARAMS.wall);
      // The definitions did NOT change — this is the other case.
      expect(afterChange.parameters).toEqual(document.parameters);

      const before = await snapshotCountOf(project.dir);

      writePreviewSample(host.controller, CANDIDATE);
      const result = await host.controller.finalize(proof);

      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("unreachable");
      expect(result.error?.error_code).toBe("CONFLICT");
      expect(host.conflicts).toEqual([project.projectId]);
      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().entries).toHaveLength(0);
      expect(await snapshotCountOf(project.dir)).toBe(before);
    } finally {
      disposeHost(host);
    }
  }, 120000);

  it("integration_binding_change_mid_gesture_invalidates_controller", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-binding-change");

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await beginTypedGesture(host, {
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        baseValue: CLAMP_PARAMS.wall,
        candidateValue: CANDIDATE
      });

      // The BINDING moves, mid-gesture: the same surface, re-bound at version
      // 2. The SOURCE side does not move — only the sidecar digest does.
      await seedSidecar(project.dir, [
        clampWallFeature(project.projectId, { bindingVersion: 2, sourceFingerprint: document.sourceFingerprint })
      ]);
      const afterChange = await readEditorDocument(host.api, project.projectId);
      expect(afterChange.sourceRevision).toBe(document.sourceRevision);
      expect(afterChange.editorRevision).not.toBe(document.editorRevision);

      const before = await snapshotCountOf(project.dir);

      writePreviewSample(host.controller, CANDIDATE);
      const result = await host.controller.finalize(proof);

      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("unreachable");
      expect(result.error?.error_code).toBe("CONFLICT");
      expect(host.conflicts).toEqual([project.projectId]);
      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().entries).toHaveLength(0);
      expect(await snapshotCountOf(project.dir)).toBe(before);
    } finally {
      disposeHost(host);
    }
  }, 120000);

  it("integration_external_redo_invalidation", async () => {
    const bus = createInMemoryBroadcastChannelFactory();
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-external-redo");

    const host = createHost({
      baseUrl: server.baseUrl,
      projectId: project.projectId,
      fetchImpl: wire.fetchImpl,
      broadcastChannelFactory: bus
    });
    const writer = createHost({
      baseUrl: server.baseUrl,
      projectId: project.projectId,
      fetchImpl: wire.fetchImpl,
      broadcastChannelFactory: bus
    });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);

      // Two accepted edits, so the log has a stack.
      const first = await commitTypedValue(host, 5);
      expect(first).toBe("committed");
      const second = await commitTypedValue(host, 7);
      expect(second).toBe("committed");
      expect(host.controller.history().entries).toHaveLength(2);
      expect(host.controller.history().cursor).toBe(2);

      // An undo leaves a redo behind.
      const undoPrepared = host.controller.prepareTraversal("undo");
      expect(undoPrepared.ok).toBe(true);
      if (!undoPrepared.ok) throw new Error("unreachable");
      const undoProof = await host.api.verifyEditorCommand(project.projectId, undoPrepared.request);
      const undone = await host.controller.submitTraversal({ request: undoPrepared.request }, undoProof);
      expect(undone.kind).toBe("committed");
      const afterUndo = await readEditorDocument(host.api, project.projectId);
      host.controller.notifyDocumentRevision(afterUndo.editorRevision);
      expect(host.controller.history().cursor).toBe(1);
      expect(host.controller.history().canRedo).toBe(true);
      expect(host.controller.history().redoTarget).not.toBeNull();

      // A SECOND WRITER commits, against the same real server.
      const writerDocument = await readEditorDocument(writer.api, project.projectId);
      const writerProof = await verifySetValue(writer.api, project.projectId, {
        baseEditorRevision: writerDocument.editorRevision,
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        value: 9
      });
      const postsBeforeExternal = wire.callsMatching((url, method) => method === "POST" && url.includes("/editor/commands")).length;
      const snapshotsBeforeExternal = await snapshotCountOf(project.dir);
      const writerResult = await writer.controller.submitVerified(
        { kind: "set-value", featureId: CLAMP_WALL_FEATURE_ID, bindingVersion: 1, value: 9 },
        writerProof,
        "edit",
        null,
        // The store holds 5 here: the second edit took it to 7 and the undo
        // above brought it back to 5.
        { beforeValue: 5 }
      );
      expect(writerResult.kind).toBe("committed");
      if (writerResult.kind !== "committed") throw new Error("unreachable");

      // F5: the store, after the second writer's commit — the stored value,
      // exactly one more snapshot, and the head being the second writer's.
      const storeAfterExternal = await readEditorDocument(host.api, project.projectId);
      expect(storeAfterExternal.values.wall).toBe(9);
      expect(await snapshotCountOf(project.dir)).toBe(snapshotsBeforeExternal + 1);
      expect(storeAfterExternal.head).toBe(writerResult.receipt.snapshotId);

      // The peer-committed signal reached the first controller.
      expect(host.peerCommitted).toBeGreaterThanOrEqual(1);

      // The host reports the external write (the production path: the cache
      // invalidates and the guard input flips) and then re-reads.
      host.controller.setGuardInputs({
        sidecarStatus: "ready",
        sourceDirty: false,
        sourceConflict: false,
        paramsDirty: false,
        paramsSaving: false,
        agentTurnRunning: false,
        externalWriteUnsettled: true
      });
      const externalRead = await readEditorDocument(host.api, project.projectId);
      host.controller.notifyDocumentRevision(externalRead.editorRevision);
      host.controller.setGuardInputs({
        sidecarStatus: "ready",
        sourceDirty: false,
        sourceConflict: false,
        paramsDirty: false,
        paramsSaving: false,
        agentTurnRunning: false,
        externalWriteUnsettled: false
      });

      // THE OBSERVABLE: the redo is gone. The redo entry went stale, the
      // redo stack offers nothing, and a redo is refused locally — nothing
      // is sent to the server.
      const history = host.controller.history();
      expect(history.canRedo).toBe(false);
      expect(history.redoTarget).toBeNull();
      expect(history.canUndo).toBe(false);
      expect(host.controller.prepareTraversal("redo")).toEqual({ ok: false, reason: "stale-log" });
      const postsAfter = wire.callsMatching((url, method) => method === "POST" && url.includes("/editor/commands"));
      // Only the second writer's commit went out after the external write —
      // the redo never reached the wire.
      expect(postsAfter).toHaveLength(postsBeforeExternal + 1);
    } finally {
      disposeHost(host);
      disposeHost(writer);
    }
  }, 180000);

  it("integration_normal_gesture_one_snapshot_one_revision_delta", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-one-snapshot");

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      const document = await readEditorDocument(host.api, project.projectId);
      const before = await snapshotCountOf(project.dir);

      // ONE typed gesture.
      const proof = await verifySetValue(host.api, project.projectId, {
        baseEditorRevision: document.editorRevision,
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        value: CANDIDATE
      });
      const began = host.controller.begin({
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        baseEditorRevision: document.editorRevision,
        sourceFingerprint: document.sourceFingerprint,
        sidecarStatus: document.sidecarStatus,
        eligibility: eligibilityOf(document, CLAMP_WALL_FEATURE_ID),
        freshProof: proof,
        baseValue: CLAMP_PARAMS.wall
      });
      expect(began.ok).toBe(true);
      expect(host.controller.propose(CANDIDATE, "typed").ok).toBe(true);
      writePreviewSample(host.controller, CANDIDATE);
      const committed = await host.controller.finalize(proof);
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") throw new Error("unreachable");

      // EXACTLY one new snapshot, and EXACTLY one revision change.
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);
      const afterGesture = await readEditorDocument(host.api, project.projectId);
      expect(afterGesture.editorRevision).toBe(committed.receipt.editorRevision);
      expect(afterGesture.sourceRevision).not.toBe(document.sourceRevision);
      expect(afterGesture.head).toBe(committed.receipt.snapshotId);
      host.controller.notifyDocumentRevision(afterGesture.editorRevision);

      // The UNDO makes exactly one more snapshot.
      const undoPrepared = host.controller.prepareTraversal("undo");
      expect(undoPrepared.ok).toBe(true);
      if (!undoPrepared.ok) throw new Error("unreachable");
      const undoProof = await host.api.verifyEditorCommand(project.projectId, undoPrepared.request);
      const undone = await host.controller.submitTraversal({ request: undoPrepared.request }, undoProof);
      expect(undone.kind).toBe("committed");
      if (undone.kind !== "committed") throw new Error("unreachable");
      expect(await snapshotCountOf(project.dir)).toBe(before + 2);
      const afterUndo = await readEditorDocument(host.api, project.projectId);
      expect(afterUndo.editorRevision).toBe(undone.receipt.editorRevision);
      host.controller.notifyDocumentRevision(afterUndo.editorRevision);

      // The REDO makes exactly one more snapshot.
      const redoPrepared = host.controller.prepareTraversal("redo");
      expect(redoPrepared.ok).toBe(true);
      if (!redoPrepared.ok) throw new Error("unreachable");
      const redoProof = await host.api.verifyEditorCommand(project.projectId, redoPrepared.request);
      const redone = await host.controller.submitTraversal({ request: redoPrepared.request }, redoProof);
      expect(redone.kind).toBe("committed");
      if (redone.kind !== "committed") throw new Error("unreachable");
      expect(await snapshotCountOf(project.dir)).toBe(before + 3);
      const afterRedo = await readEditorDocument(host.api, project.projectId);
      expect(afterRedo.editorRevision).toBe(redone.receipt.editorRevision);
    } finally {
      disposeHost(host);
    }
  }, 180000);
});

/** One real typed gesture, committed, with the host's post-commit read. */
async function commitTypedValue(host: QualificationHost, value: number): Promise<string> {
  const document = await readEditorDocument(host.api, host.projectId);
  const proof = await verifySetValue(host.api, host.projectId, {
    baseEditorRevision: document.editorRevision,
    featureId: CLAMP_WALL_FEATURE_ID,
    bindingVersion: 1,
    value
  });
  const began = host.controller.begin({
    featureId: CLAMP_WALL_FEATURE_ID,
    bindingVersion: 1,
    baseEditorRevision: document.editorRevision,
    sourceFingerprint: document.sourceFingerprint,
    sidecarStatus: document.sidecarStatus,
    eligibility: eligibilityOf(document, CLAMP_WALL_FEATURE_ID),
    freshProof: proof,
    baseValue: Number(document.values.wall)
  });
  expect(began.ok).toBe(true);
  expect(host.controller.propose(value, "typed").ok).toBe(true);
  writePreviewSample(host.controller, value);
  const result = await host.controller.finalize(proof);
  const after = await readEditorDocument(host.api, host.projectId);
  host.controller.notifyDocumentRevision(after.editorRevision);
  return result.kind;
}
