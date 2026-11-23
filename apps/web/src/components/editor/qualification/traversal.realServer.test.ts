// SPDX-License-Identifier: Apache-2.0
//
// S3-C C5 (Issue #137, Stage 1) — the engine-free half of carried comment 2.
//
// Carried comment 2 rests on one server rule: a traversal whose SUBMITTED
// command differs from the server's own derived inverse is REFUSED. The
// seven `@docker` cases in `traversal.realServer.docker.test.ts` prove the
// AGREEMENT side of that rule (the server accepts the client's inverse, for
// every kind and direction). This file proves the other half — the server's
// refusal is real — and it can, because a `remove-feature` command's proof
// is engine-free: `runProbe` returns for `remove-feature` before it plans or
// renders a sample, so the proof is minted in-process with scad-core's
// `runProbe` + `persistProofRecord` (the
// `apps/server/src/services/fault-editor-matrix.test.ts` precedent).
//
// CONSEQUENCE FOR THE FILE SPLIT (stated in the PR body): every POSITIVE
// agreement case is `@docker`, because a traversal's proof must cover the
// INVERSE command, and every inverse except `remove-feature`'s own redo is a
// `put-feature` or a `set-value` — both of which render real samples through
// the pinned OpenSCAD image. This file therefore holds the case that needs
// no engine: the server's own exactness.
//
// PROOF SOURCE (Tech-Lead condition 3): T1, T2 and T3 may mint
// `remove-feature` proofs in-process; this file does, and says so. It does
// NOT exercise the HTTP verify route.
//
// WHAT THE TEST PLAYS THE HOST (Tech-Lead condition 4): where `App` /
// `useEditorSession` would re-read the editor document and call
// `notifyDocumentRevision`, this file does the same thing — always from a
// real server read.

import { randomUUID } from "node:crypto";
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
  HOOK_TIMEOUT_MS,
  mintRemoveFeatureProof,
  readEditorDocument,
  seedSidecar,
  snapshotCountOf,
  startServerChild,
  type ChildTracker,
  type InterceptedFetch,
  type ServerChildHandle,
  type TempProjectsDir
} from "./realServerHarness.js";

const MODEL_SCAD = "size = 10;\ncube(size);\n";

const FEATURE_A = "11111111-1111-4111-8111-111111111111";
const FEATURE_B = "22222222-2222-4222-8222-222222222222";

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
  await tracker.killAll();
  await projects.cleanup();
}, HOOK_TIMEOUT_MS);

describe("C5 the real server refuses a traversal whose command is not the exact inverse", () => {
  it("integration_remove_feature_undo_with_a_wrong_inverse_is_refused_by_the_server", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-wrong-inverse", scad: MODEL_SCAD });
    const original = feature(project.projectId, FEATURE_A);
    const other = feature(project.projectId, FEATURE_B);
    await seedSidecar(project.dir, [original, other]);

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
        bindingVersion: 1,
        // The proof's digest covers the intent, so it must be the intent the
        // commit is submitted under (`setup`, for a remove-feature).
        intent: "setup"
      });

      // The forward operation: a real, accepted `remove-feature` commit.
      const committed = await host.controller.submitVerified(
        { kind: "remove-feature", featureId: FEATURE_A, bindingVersion: 1 },
        proof,
        "setup",
        null,
        { beforeFeature: original }
      );
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") throw new Error("unreachable");
      const operationId = committed.receipt.operationId;

      const afterCommit = await readEditorDocument(host.api, project.projectId);
      host.controller.notifyDocumentRevision(afterCommit.editorRevision);
      const before = await snapshotCountOf(project.dir);

      // The CLIENT's derived inverse is the before-image, put back.
      const prepared = host.controller.prepareTraversal("undo");
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error("unreachable");
      expect(prepared.request.command.kind).toBe("put-feature");
      expect(prepared.request.intent).toBe("undo");
      expect(prepared.request.traversal).toEqual({ operationId, direction: "undo" });

      // A WRONG inverse — a real command, but not the inverse of the accepted
      // operation — is refused LOCALLY by the controller: it never puts such a
      // request on the wire. (It removes the OTHER feature, which is still in
      // the sidecar, so its proof is a genuine one.)
      const wrongProof = await mintRemoveFeatureProof({
        dir: project.dir,
        projectId: project.projectId,
        baseEditorRevision: prepared.request.baseEditorRevision,
        scad: project.scad,
        params: afterCommit.values,
        features: afterCommit.sidecar.features,
        featureId: FEATURE_B,
        bindingVersion: 1,
        intent: "undo",
        traversal: { operationId, direction: "undo" }
      });
      const local = await host.controller.submitVerified(
        { kind: "remove-feature", featureId: FEATURE_B, bindingVersion: 1 },
        wrongProof,
        "undo",
        { operationId, direction: "undo" },
        null
      );
      expect(local).toEqual({ kind: "refused", reason: "target-changed" });
      expect(wire.callsMatching((url, method) => method === "POST" && url.includes("/editor/commands"))).toHaveLength(1);

      // And the SERVER refuses one too, when it is asked directly over the
      // real route with a genuine proof for exactly that request.
      const posted = await host.api
        .commitEditorCommand(project.projectId, {
          version: 1,
          baseEditorRevision: wrongProof.baseEditorRevision,
          command: { kind: "remove-feature", featureId: FEATURE_B, bindingVersion: 1 },
          intent: "undo",
          traversal: { operationId, direction: "undo" },
          operationId: randomUUID(),
          proofId: wrongProof.proofId
        })
        .then(
          () => null,
          (cause: unknown) => cause
        );
      expect(posted).not.toBeNull();
      const failure = posted as { error_code?: string; message?: string };
      expect(failure.error_code).toBe("VALIDATION_FAILED");
      expect(failure.message).toContain("does not match the exact inverse");

      // Nothing was committed by the refused traversal.
      expect(await snapshotCountOf(project.dir)).toBe(before);
      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.sidecar.features).toHaveLength(1);
      expect(after.sidecar.features[0].featureId).toBe(FEATURE_B);
    } finally {
      disposeHost(host);
    }
  }, 60000);
});
