// SPDX-License-Identifier: Apache-2.0
//
// S3-C C5 — criterion 1 of Issue #137 (Stage 1): the controller's remaining
// spec §9.2 integration cases, against the REAL server routes and the
// PRODUCTION store.
//
// What is real in this file: the controller (`controller/controller.ts`), the
// C1 editor client (`client/editorClient.ts`), `lib/apiClient.ts`, the built
// `apps/server` running as a child process, and the filesystem project store
// under a temp `SCADFORGE_PROJECTS_DIR`. Nothing on the server side is
// mocked: the only shaping is on the WIRE — the harness's fetch interceptor
// can hold a request before it is sent, withhold a response, or lose a
// response. It never invents an answer; every body these tests read came
// from the real server.
//
// WHAT THE TEST PLAYS THE HOST (Tech-Lead condition 4): where `App` /
// `useEditorSession` would re-read the editor document and call
// `notifyDocumentRevision`, this file does the same thing — always from a
// real server read, never from a value it made up.
//
// PROOF SOURCE (Tech-Lead condition 3): every commit in this file is a
// `remove-feature`, whose probe is engine-free (`runProbe` returns before it
// plans or renders a sample), so its proof is minted in-process with
// scad-core's `runProbe` + `persistProofRecord` — the
// `apps/server/src/services/fault-editor-matrix.test.ts` precedent. This file
// therefore does NOT exercise the HTTP verify route; the `@docker` files do.
//
// These four cases are the engine-free half of criterion 1. The other five —
// the cancel-before-submit case, the three `mid_gesture` cases and the
// external redo invalidation — need a real gesture, and a real gesture is a
// `set-value`, whose proof renders through the pinned OpenSCAD image. They
// live in `gesture.realServer.docker.test.ts`.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EditorFeature } from "@scadforge/protocol";
import {
  assertServerBuilt,
  createChildTracker,
  createHost,
  createInterceptedFetch,
  createProject,
  createProjectsDir,
  disposeHost,
  mintRemoveFeatureProof,
  readEditorDocument,
  seedSidecar,
  snapshotCountOf,
  startServerChild,
  waitFor,
  type ChildTracker,
  type InterceptedFetch,
  type ServerChildHandle,
  type TempProjectsDir
} from "./realServerHarness.js";

const MODEL_SCAD = "size = 10;\ncube(size);\n";

const FEATURE_A = "11111111-1111-4111-8111-111111111111";
const FEATURE_B = "22222222-2222-4222-8222-222222222222";
const FEATURE_C = "33333333-3333-4333-8333-333333333333";

function feature(projectId: string, featureId: string): EditorFeature {
  return {
    featureId,
    label: `Feature ${featureId.slice(0, 8)}`,
    projectId,
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "size", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } }
  };
}

function removeCommand(featureId: string): { kind: "remove-feature"; featureId: string; bindingVersion: number } {
  return { kind: "remove-feature", featureId, bindingVersion: 1 };
}

let tracker: ChildTracker;
let server: ServerChildHandle;
let projects: TempProjectsDir;
let wire: InterceptedFetch;

beforeAll(async () => {
  // The real-server tests need the built server; fail at once with the fix.
  await assertServerBuilt();
});

beforeEach(async () => {
  tracker = createChildTracker();
  projects = await createProjectsDir();
  server = await startServerChild(tracker, projects.dir);
  wire = createInterceptedFetch();
});

afterEach(async () => {
  await tracker.killAll();
  await projects.cleanup();
});

describe("C5 controller qualification against the real server (criterion 1)", () => {
  it("integration_ambiguous_receipt_resolves_to_committed_on_poll", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-ambiguous-committed", scad: MODEL_SCAD });
    const features = [feature(project.projectId, FEATURE_A), feature(project.projectId, FEATURE_B)];
    await seedSidecar(project.dir, features);

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await mintRemoveFeatureProof({
        dir: project.dir,
        projectId: project.projectId,
        baseEditorRevision: document.editorRevision,
        scad: project.scad,
        params: document.values,
        features: document.sidecar.features,
        featureId: FEATURE_A,
        bindingVersion: 1
      });

      // The response is LOST after the server committed: the request really
      // goes out and really commits, the caller just never sees the answer.
      wire.dropNextResponse((url, method) => method === "POST" && url.includes("/editor/commands"));
      const before = await snapshotCountOf(project.dir);

      const result = await host.controller.submitVerified(
        removeCommand(FEATURE_A),
        proof,
        "edit",
        null,
        { beforeFeature: features[0] }
      );

      // The client could not classify the attempt, so it polled the REAL
      // operations route and the REAL claim said `committed`.
      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") throw new Error("unreachable");
      expect(result.receipt.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.receipt.snapshotId).toBeTruthy();

      const polls = wire.callsMatching((url, method) => method === "GET" && url.includes("/editor/operations/"));
      expect(polls.length).toBeGreaterThanOrEqual(1);

      // The store: exactly one new snapshot — the commit happened once.
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);

      // The controller stays `committing` with the receipt until the host
      // confirms a coherent read (R3), then it goes idle with one log entry.
      const committing = host.controller.state();
      expect(committing.kind).toBe("committing");
      if (committing.kind !== "committing") throw new Error("unreachable");
      expect(committing.receipt?.snapshotId).toBe(result.receipt.snapshotId);

      const afterRead = await readEditorDocument(host.api, project.projectId);
      expect(afterRead.editorRevision).toBe(result.receipt.editorRevision);
      host.controller.notifyDocumentRevision(afterRead.editorRevision);

      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().entries).toHaveLength(1);
      expect(host.controller.history().canUndo).toBe(true);
      expect(host.conflicts).toEqual([]);
    } finally {
      disposeHost(host);
    }
  }, 30000);

  it("integration_ambiguous_receipt_resolves_to_rejected_on_poll", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-ambiguous-rejected", scad: MODEL_SCAD });
    const features = [feature(project.projectId, FEATURE_A), feature(project.projectId, FEATURE_B)];
    await seedSidecar(project.dir, features);

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await mintRemoveFeatureProof({
        dir: project.dir,
        projectId: project.projectId,
        baseEditorRevision: document.editorRevision,
        scad: project.scad,
        params: document.values,
        features: document.sidecar.features,
        featureId: FEATURE_A,
        bindingVersion: 1
      });

      // The base revision goes stale AFTER the proof was minted: the sidecar
      // changes, so the editor revision moves and the real server refuses the
      // commit with a real 409 (and reserves a TERMINAL rejected claim).
      await seedSidecar(project.dir, [...features, feature(project.projectId, FEATURE_C)]);

      wire.dropNextResponse((url, method) => method === "POST" && url.includes("/editor/commands"));
      const before = await snapshotCountOf(project.dir);

      const result = await host.controller.submitVerified(
        removeCommand(FEATURE_A),
        proof,
        "edit",
        null,
        { beforeFeature: features[0] }
      );

      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("unreachable");
      expect(result.reason).toBe("rejected");
      expect(result.error?.error_code).toBe("CONFLICT");

      // The definite CONFLICT reached the host's cache-invalidation hook.
      expect(host.conflicts).toEqual([project.projectId]);

      // Nothing was committed.
      expect(await snapshotCountOf(project.dir)).toBe(before);
      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().entries).toHaveLength(0);

      // The refusal really was the server's, and it really was a 409.
      const post = wire.callsMatching((url, method) => method === "POST" && url.includes("/editor/commands"));
      expect(post).toHaveLength(1);
      expect(post[0].status).toBe(409);
      expect(post[0].errorBody?.error_code).toBe("CONFLICT");
    } finally {
      disposeHost(host);
    }
  }, 30000);

  it("integration_old_project_receipt_after_navigation_does_not_paint_new_project", async () => {
    const projectA = await createProject(server.baseUrl, projects.dir, { name: "c5-nav-a", scad: MODEL_SCAD });
    const projectB = await createProject(server.baseUrl, projects.dir, { name: "c5-nav-b", scad: MODEL_SCAD });
    const featureA = feature(projectA.projectId, FEATURE_A);
    const featureB = feature(projectB.projectId, FEATURE_B);
    await seedSidecar(projectA.dir, [featureA]);
    await seedSidecar(projectB.dir, [featureB]);

    const hostA = createHost({ baseUrl: server.baseUrl, projectId: projectA.projectId, fetchImpl: wire.fetchImpl });
    const hostB = createHost({ baseUrl: server.baseUrl, projectId: projectB.projectId, fetchImpl: wire.fetchImpl });
    try {
      const documentA = await readEditorDocument(hostA.api, projectA.projectId);
      const proofA = await mintRemoveFeatureProof({
        dir: projectA.dir,
        projectId: projectA.projectId,
        baseEditorRevision: documentA.editorRevision,
        scad: projectA.scad,
        params: documentA.values,
        features: documentA.sidecar.features,
        featureId: FEATURE_A,
        bindingVersion: 1
      });

      const documentB = await readEditorDocument(hostB.api, projectB.projectId);
      const bBefore = await snapshotCountOf(projectB.dir);

      // A's receipt is withheld until after the navigation.
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      wire.delayNextResponse(
        (url, method) => method === "POST" && url.includes("/editor/commands") && url.includes(projectA.projectId),
        gate
      );

      const pending = hostA.controller.submitVerified(
        removeCommand(FEATURE_A),
        proofA,
        "edit",
        null,
        { beforeFeature: featureA }
      );

      // The request really went out (the server really committed) and the
      // response is still held.
      await waitFor(
        () => wire.callsMatching((url, method) => method === "POST" && url.includes("/editor/commands")).length === 1,
        { description: "A's commit to reach the wire", timeoutMs: 10_000 }
      );
      expect(hostA.controller.state().kind).toBe("committing");

      // Navigation away from A: the controller detaches and remembers the
      // in-flight operation for a later reconciliation.
      const detachedOperationId = hostA.controller.detach();
      expect(detachedOperationId).not.toBeNull();

      // A's receipt arrives late — after the switch.
      openGate();
      const settled = await pending;
      expect(settled.kind).toBe("detached");

      // B is untouched: no state, no log, no revision, no snapshot.
      expect(hostB.controller.state().kind).toBe("idle");
      expect(hostB.controller.history().entries).toHaveLength(0);
      expect(hostB.controller.history().canUndo).toBe(false);
      expect(hostB.controller.history().canRedo).toBe(false);
      const afterB = await readEditorDocument(hostB.api, projectB.projectId);
      expect(afterB.editorRevision).toBe(documentB.editorRevision);
      expect(await snapshotCountOf(projectB.dir)).toBe(bBefore);

      // A's commit really happened on the server — it was never "painted"
      // anywhere, but it is not lost either.
      expect(await snapshotCountOf(projectA.dir)).toBe(2);
    } finally {
      disposeHost(hostA);
      disposeHost(hostB);
    }
  }, 30000);

  it("integration_stale_undo_does_not_move_cursor", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-stale-undo", scad: MODEL_SCAD });
    const features = [feature(project.projectId, FEATURE_A), feature(project.projectId, FEATURE_B)];
    await seedSidecar(project.dir, features);

    const host = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    const writer = createHost({ baseUrl: server.baseUrl, projectId: project.projectId, fetchImpl: wire.fetchImpl });
    try {
      const document = await readEditorDocument(host.api, project.projectId);
      const proof = await mintRemoveFeatureProof({
        dir: project.dir,
        projectId: project.projectId,
        baseEditorRevision: document.editorRevision,
        scad: project.scad,
        params: document.values,
        features: document.sidecar.features,
        featureId: FEATURE_A,
        bindingVersion: 1
      });

      const before = await snapshotCountOf(project.dir);
      const committed = await host.controller.submitVerified(
        removeCommand(FEATURE_A),
        proof,
        "edit",
        null,
        { beforeFeature: features[0] }
      );
      expect(committed.kind).toBe("committed");

      // The host's post-commit read: the controller goes idle with one entry.
      const afterCommit = await readEditorDocument(host.api, project.projectId);
      host.controller.notifyDocumentRevision(afterCommit.editorRevision);
      expect(host.controller.state().kind).toBe("idle");
      expect(host.controller.history().cursor).toBe(1);
      expect(host.controller.history().canUndo).toBe(true);

      // A SECOND WRITER commits, against the same real server.
      const document2 = await readEditorDocument(writer.api, project.projectId);
      const proofB = await mintRemoveFeatureProof({
        dir: project.dir,
        projectId: project.projectId,
        baseEditorRevision: document2.editorRevision,
        scad: project.scad,
        params: document2.values,
        features: document2.sidecar.features,
        featureId: FEATURE_B,
        bindingVersion: 1
      });
      const second = await writer.controller.submitVerified(
        removeCommand(FEATURE_B),
        proofB,
        "edit",
        null,
        { beforeFeature: features[1] }
      );
      expect(second.kind).toBe("committed");

      // The host re-reads after the external write and tells the controller
      // what the document now says — a revision from a COMPLETED real read.
      const afterExternal = await readEditorDocument(host.api, project.projectId);
      expect(afterExternal.editorRevision).not.toBe(afterCommit.editorRevision);
      host.controller.notifyDocumentRevision(afterExternal.editorRevision);

      // The entry is stale, the cursor did not move, and the undo is refused
      // LOCALLY — nothing is sent.
      const history = host.controller.history();
      expect(history.entries[0].stale).toBe(true);
      expect(history.canUndo).toBe(false);
      expect(history.cursor).toBe(1);
      const prepared = host.controller.prepareTraversal("undo");
      expect(prepared).toEqual({ ok: false, reason: "stale-log" });

      // Exactly two commits reached the server: the first writer's and the
      // second writer's. The undo never went out.
      const posts = wire.callsMatching((url, method) => method === "POST" && url.includes("/editor/commands"));
      expect(posts).toHaveLength(2);
      expect(await snapshotCountOf(project.dir)).toBe(before + 2);
    } finally {
      disposeHost(host);
      disposeHost(writer);
    }
  }, 30000);
});
