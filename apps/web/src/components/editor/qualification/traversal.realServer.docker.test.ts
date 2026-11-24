// SPDX-License-Identifier: Apache-2.0
//
// @docker — S3-C C5 (Issue #137, Stage 1), carried comment 2: the CLIENT's
// undo/redo inverse commands must AGREE with the server's own derivation.
//
// The client builds each inverse itself (`controller/traversalCommand.ts`,
// mirroring `deriveTraversal` in `packages/scad-core/src/editor/commands.ts`);
// the server refuses any traversal whose SUBMITTED command differs from its
// own derived inverse. These cases prove the agreement for every kind and
// direction against the REAL server: set-value undo and redo, put-feature
// (new) undo and redo, put-feature (replacing) undo, remove-feature undo and
// redo.
//
// A case proves agreement by the server ACCEPTING the client's inverse and
// the resulting state being the inverse — a server that disagreed would
// refuse with VALIDATION_FAILED "The submitted command does not match the
// exact inverse of the referenced operation", and nothing would be committed.
//
// @docker — every proof here comes from the REAL HTTP verify route
// (`apiClient.verifyEditorCommand`, Tech-Lead condition 3): this file never
// mints a proof in process. A traversal's proof must cover the INVERSE
// command, and every inverse here except `remove-feature`'s own redo is a
// `put-feature` or a `set-value` — both of which render real samples through
// the pinned OpenSCAD image. The geometry is the repository's clamp fixture,
// whose linear wall binding is already proven by
// `packages/scad-core/src/editor/proof.docker.test.ts`.
//
// WHAT THE TEST PLAYS THE HOST (Tech-Lead condition 4): where `App` /
// `useEditorSession` would re-read the editor document and call
// `notifyDocumentRevision`, this file does the same thing — always from a
// real server read.

import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EditorCommand, EditorFeature, EditorProofResponse } from "@scadforge/protocol";
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
  readEditorDocument,
  seedSidecar,
  snapshotCountOf,
  startServerChild,
  writePreviewSample,
  type ChildTracker,
  type InterceptedFetch,
  type QualificationHost,
  type ServerChildHandle,
  type TempProjectsDir
} from "./realServerHarness.js";

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

/** The client's derived inverse for a direction, straight from the controller. */
async function derivedInverse(host: QualificationHost, direction: "undo" | "redo"): Promise<EditorCommand> {
  const prepared = host.controller.prepareTraversal(direction);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error("unreachable");
  return prepared.request.command;
}

/** Verify the client's derived request through the REAL verify route, submit it, and let the host re-read. */
async function submitDerivedTraversal(
  host: QualificationHost,
  direction: "undo" | "redo"
): Promise<{ kind: string; errorCode: string | null }> {
  const prepared = host.controller.prepareTraversal(direction);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error("unreachable");
  const proof: EditorProofResponse = await host.api.verifyEditorCommand(host.projectId, prepared.request);
  const result = await host.controller.submitTraversal({ request: prepared.request }, proof);
  const after = await readEditorDocument(host.api, host.projectId);
  host.controller.notifyDocumentRevision(after.editorRevision);
  if (result.kind === "committed") return { kind: "committed", errorCode: null };
  if (result.kind === "rejected") return { kind: "rejected", errorCode: result.error?.error_code ?? null };
  return { kind: result.kind, errorCode: null };
}

/** A real typed gesture (a `set-value`), committed, with the host's post-commit read. */
async function commitTypedValue(host: QualificationHost, value: number): Promise<void> {
  const document = await readEditorDocument(host.api, host.projectId);
  const proof = await host.api.verifyEditorCommand(host.projectId, {
    version: 1,
    baseEditorRevision: document.editorRevision,
    command: { kind: "set-value", featureId: CLAMP_WALL_FEATURE_ID, bindingVersion: 1, value },
    intent: "edit",
    traversal: null
  });
  host.controller.begin({
    featureId: CLAMP_WALL_FEATURE_ID,
    bindingVersion: 1,
    baseEditorRevision: document.editorRevision,
    sourceFingerprint: document.sourceFingerprint,
    sidecarStatus: document.sidecarStatus,
    eligibility: document.eligibility.find((entry) => entry.featureId === CLAMP_WALL_FEATURE_ID) ?? null,
    freshProof: proof,
    baseValue: Number(document.values.wall)
  });
  expect(host.controller.propose(value, "typed").ok).toBe(true);
  writePreviewSample(host.controller, value);
  const result = await host.controller.finalize(proof);
  expect(result.kind).toBe("committed");
  const after = await readEditorDocument(host.api, host.projectId);
  host.controller.notifyDocumentRevision(after.editorRevision);
}

/** A real `put-feature` / `remove-feature` commit (`intent: "setup"`, as the controller's own doc prescribes). */
async function commitSetupCommand(
  host: QualificationHost,
  command: EditorCommand,
  beforeFeature: EditorFeature | null
): Promise<void> {
  const document = await readEditorDocument(host.api, host.projectId);
  const proof = await host.api.verifyEditorCommand(host.projectId, {
    version: 1,
    baseEditorRevision: document.editorRevision,
    command,
    intent: "setup",
    traversal: null
  });
  const result = await host.controller.submitVerified(command, proof, "setup", null, { beforeFeature });
  expect(result.kind).toBe("committed");
  const after = await readEditorDocument(host.api, host.projectId);
  host.controller.notifyDocumentRevision(after.editorRevision);
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

describe.skipIf(!dockerAvailable())("@docker C5 client/server undo-redo inverse agreement (carried comment 2)", () => {
  it("integration_set_value_undo_inverse_agrees_with_server", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-setvalue-undo");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      await commitTypedValue(host, CANDIDATE);
      const before = await snapshotCountOf(project.dir);

      // The client's own inverse of the accepted set-value.
      const inverse = await derivedInverse(host, "undo");
      expect(inverse).toEqual({
        kind: "set-value",
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        value: CLAMP_PARAMS.wall
      });

      const outcome = await submitDerivedTraversal(host, "undo");
      // The REAL server accepted the client's inverse instead of refusing it
      // with "does not match the exact inverse".
      expect(outcome).toEqual({ kind: "committed", errorCode: null });
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.values.wall).toBe(CLAMP_PARAMS.wall);
    } finally {
      disposeHost(host);
    }
  }, 180000);

  it("integration_set_value_redo_inverse_agrees_with_server", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-setvalue-redo");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, [clampWallFeature(project.projectId)]);
      await commitTypedValue(host, CANDIDATE);
      expect((await submitDerivedTraversal(host, "undo")).kind).toBe("committed");
      const before = await snapshotCountOf(project.dir);

      const inverse = await derivedInverse(host, "redo");
      expect(inverse).toEqual({
        kind: "set-value",
        featureId: CLAMP_WALL_FEATURE_ID,
        bindingVersion: 1,
        value: CANDIDATE
      });

      const outcome = await submitDerivedTraversal(host, "redo");
      expect(outcome).toEqual({ kind: "committed", errorCode: null });
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.values.wall).toBe(CANDIDATE);
    } finally {
      disposeHost(host);
    }
  }, 240000);

  it("integration_put_feature_new_undo_inverse_agrees_with_server", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-putfeature-new-undo");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      // An empty sidecar: the feature does not exist yet.
      await seedSidecar(project.dir, []);
      const document = await readEditorDocument(host.api, project.projectId);
      const feature = clampWallFeature(project.projectId, {
        createdAtRevision: document.editorRevision,
        sourceFingerprint: document.sourceFingerprint
      });
      await commitSetupCommand(host, { kind: "put-feature", feature }, null);
      const before = await snapshotCountOf(project.dir);

      // The client's inverse of a create is a REMOVE.
      const inverse = await derivedInverse(host, "undo");
      expect(inverse).toEqual({ kind: "remove-feature", featureId: CLAMP_WALL_FEATURE_ID, bindingVersion: 1 });

      const outcome = await submitDerivedTraversal(host, "undo");
      expect(outcome).toEqual({ kind: "committed", errorCode: null });
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.sidecar.features).toHaveLength(0);
    } finally {
      disposeHost(host);
    }
  }, 240000);

  it("integration_put_feature_new_redo_inverse_agrees_with_server", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-putfeature-new-redo");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      await seedSidecar(project.dir, []);
      const document = await readEditorDocument(host.api, project.projectId);
      const feature = clampWallFeature(project.projectId, {
        createdAtRevision: document.editorRevision,
        sourceFingerprint: document.sourceFingerprint
      });
      await commitSetupCommand(host, { kind: "put-feature", feature }, null);
      expect((await submitDerivedTraversal(host, "undo")).kind).toBe("committed");
      const before = await snapshotCountOf(project.dir);

      // The client's inverse of an undo of a create is the CREATE again.
      const inverse = await derivedInverse(host, "redo");
      expect(inverse.kind).toBe("put-feature");
      if (inverse.kind !== "put-feature") throw new Error("unreachable");
      expect(inverse.feature.featureId).toBe(CLAMP_WALL_FEATURE_ID);

      const outcome = await submitDerivedTraversal(host, "redo");
      expect(outcome).toEqual({ kind: "committed", errorCode: null });
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.sidecar.features).toHaveLength(1);
      expect(after.sidecar.features[0].featureId).toBe(CLAMP_WALL_FEATURE_ID);
    } finally {
      disposeHost(host);
    }
  }, 300000);

  it("integration_put_feature_replacing_undo_inverse_agrees_with_server", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-putfeature-replacing-undo");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      const original = clampWallFeature(project.projectId);
      await seedSidecar(project.dir, [original]);
      const document = await readEditorDocument(host.api, project.projectId);
      // The replacement re-binds the same surface at binding version 2.
      const replacement = clampWallFeature(project.projectId, {
        bindingVersion: 2,
        createdAtRevision: document.editorRevision,
        sourceFingerprint: document.sourceFingerprint
      });
      await commitSetupCommand(host, { kind: "put-feature", feature: replacement }, original);
      const before = await snapshotCountOf(project.dir);

      // The client's inverse of a replacement is the BEFORE-image, put back.
      const inverse = await derivedInverse(host, "undo");
      expect(inverse.kind).toBe("put-feature");
      if (inverse.kind !== "put-feature") throw new Error("unreachable");
      expect(inverse.feature.bindingVersion).toBe(1);
      expect(inverse.feature.featureId).toBe(CLAMP_WALL_FEATURE_ID);

      const outcome = await submitDerivedTraversal(host, "undo");
      expect(outcome).toEqual({ kind: "committed", errorCode: null });
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.sidecar.features).toHaveLength(1);
      expect(after.sidecar.features[0].bindingVersion).toBe(1);
    } finally {
      disposeHost(host);
    }
  }, 300000);

  it("integration_remove_feature_undo_inverse_agrees_with_server", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-removefeature-undo");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      const original = clampWallFeature(project.projectId);
      await seedSidecar(project.dir, [original]);
      await commitSetupCommand(host, { kind: "remove-feature", featureId: CLAMP_WALL_FEATURE_ID, bindingVersion: 1 }, original);
      const before = await snapshotCountOf(project.dir);

      // The client's inverse of a removal is the BEFORE-image, put back.
      const inverse = await derivedInverse(host, "undo");
      expect(inverse.kind).toBe("put-feature");
      if (inverse.kind !== "put-feature") throw new Error("unreachable");
      expect(inverse.feature.featureId).toBe(CLAMP_WALL_FEATURE_ID);
      expect(inverse.feature.bindingVersion).toBe(1);

      const outcome = await submitDerivedTraversal(host, "undo");
      expect(outcome).toEqual({ kind: "committed", errorCode: null });
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.sidecar.features).toHaveLength(1);
      expect(after.sidecar.features[0].featureId).toBe(CLAMP_WALL_FEATURE_ID);
    } finally {
      disposeHost(host);
    }
  }, 300000);

  it("integration_remove_feature_redo_inverse_agrees_with_server", async () => {
    const project = await createClampProject(server.baseUrl, projects.dir, "c5-removefeature-redo");
    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      const original = clampWallFeature(project.projectId);
      await seedSidecar(project.dir, [original]);
      await commitSetupCommand(host, { kind: "remove-feature", featureId: CLAMP_WALL_FEATURE_ID, bindingVersion: 1 }, original);
      expect((await submitDerivedTraversal(host, "undo")).kind).toBe("committed");
      const before = await snapshotCountOf(project.dir);

      // The client's inverse of an undo of a removal is the removal again.
      const inverse = await derivedInverse(host, "redo");
      expect(inverse).toEqual({ kind: "remove-feature", featureId: CLAMP_WALL_FEATURE_ID, bindingVersion: 1 });

      const outcome = await submitDerivedTraversal(host, "redo");
      expect(outcome).toEqual({ kind: "committed", errorCode: null });
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.sidecar.features).toHaveLength(0);
    } finally {
      disposeHost(host);
    }
  }, 360000);
});
