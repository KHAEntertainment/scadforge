// SPDX-License-Identifier: Apache-2.0
//
// S3-C C5 — criterion 2 of Issue #137 (Stage 1): the three real-server seam
// cases from the PR #116 delta review, plus the limit carried forward from
// Issue #137's first comment.
//
// What is real in this file: the controller (`controller/controller.ts`), the
// C1 editor client (`client/editorClient.ts`), `lib/apiClient.ts`, the built
// `apps/server` running as a child process, and the filesystem project store
// under a temp `SCADFORGE_PROJECTS_DIR`. Nothing on the server side is
// mocked: the only shaping is on the WIRE — the harness's fetch interceptor
// can hold a request before it is sent, withhold a response, or lose a
// response. It never invents an answer.
//
// WHAT THE TEST PLAYS THE HOST (Tech-Lead condition 4): where `App` /
// `useEditorSession` would re-read the editor document and call
// `notifyDocumentRevision`, this file does the same thing — always from a
// real server read.
//
// PROOF SOURCE (Tech-Lead condition 3): every commit in this file is a
// `remove-feature`, whose probe is engine-free (`runProbe` returns before it
// plans or renders a sample), so its proof is minted in-process with
// scad-core's `runProbe` + `persistProofRecord` — the
// `apps/server/src/services/fault-editor-matrix.test.ts` precedent. This file
// therefore does NOT exercise the HTTP verify route; the `@docker` files do.
//
// THE LOCK-CONTENTION CASE (Tech-Lead condition 5): the Issue's wording is
// "a retry of an ambiguous commit gets 409 from lock contention while THE
// ORIGINAL holds the lock". This file holds the lock in the TEST PROCESS, on
// the original's behalf, so the retry meets REAL lock contention — the
// server's own `FILE_LOCK_MAX_WAIT_MS` wait expires and the real route
// refuses with a real 409. The difference from the Issue's wording is
// deliberate and is stated in the PR body: the lock is held by the test
// process, not by the original request, so the refusal is deterministic
// instead of a race against the original's own transaction duration.
//
// THE CARRIED LIMIT (Issue #137 comment 1, item 3): the real-server case
// asserts only the OBSERVED behaviour — an ambiguous operation whose re-send
// is refused before a claim is reserved stays ambiguous while the controller
// polls. It asserts no ending of its own; what SHOULD end that ambiguity is
// a separate contract question on the Issue.

import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withRecoveredProject } from "@scadforge/scad-core";
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
  readProjectHeadLockFree,
  seedSidecar,
  snapshotCountOf,
  startServerChild,
  waitFor,
  type ChildTracker,
  type FetchHold,
  type InterceptedFetch,
  type ServerChildHandle,
  type TempProjectsDir
} from "./realServerHarness.js";

const MODEL_SCAD = "size = 10;\ncube(size);\n";

const FEATURE_A = "11111111-1111-4111-8111-111111111111";
const FEATURE_B = "22222222-2222-4222-8222-222222222222";

/** The client's own per-attempt timeout for the seam cases: a deliberate ambiguity must not cost 15 seconds. */
const SHORT_TIMEOUT_MS = 2000;

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

/** Only the editor traffic — the document reads and the health probes are noise here. */
function editorTraffic(wire: InterceptedFetch) {
  return wire.calls.filter((call) => call.url.includes("/editor/commands") || call.url.includes("/editor/operations/"));
}

/** The real project lock, held by THIS process, released on demand. */
interface HeldLock {
  /** Resolves once the lock is really held. */
  readonly held: Promise<void>;
  release(): Promise<void>;
}

async function holdProjectLock(dir: string): Promise<HeldLock> {
  let markHeld!: () => void;
  let markReleased!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const releaseGate = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  const done = withRecoveredProject(dir, async () => {
    markHeld();
    await releaseGate;
  }).catch(() => undefined);
  await held;
  return {
    held,
    release: async () => {
      markReleased();
      await done;
    }
  };
}

/** The operation-claim file the server writes when it reserves a claim. */
function claimPathOf(dir: string, operationId: string): string {
  return join(dir, ".scadforge", "editor-operations", `${operationId}.json`);
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
});

afterEach(async () => {
  await tracker.killAll();
  await projects.cleanup();
});

describe("C5 real-server seam cases (criterion 2)", () => {
  it("integration_delayed_original_post_after_unclaimed_lookup_commits_once", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-seam-delayed", scad: MODEL_SCAD });
    const features = [feature(project.projectId, FEATURE_A), feature(project.projectId, FEATURE_B)];
    await seedSidecar(project.dir, features);

    const host = createHost({
      baseUrl: server.baseUrl,
      projectId: project.projectId,
      fetchImpl: wire.fetchImpl,
      timeoutMs: SHORT_TIMEOUT_MS
    });
    const holds: FetchHold[] = [];
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

      // The ORIGINAL POST is queued but never put on the wire: the server has
      // not seen the operation at all while the client is waiting.
      const held = wire.holdNext((url, method) => method === "POST" && url.includes("/editor/commands"));
      holds.push(held);

      const before = await snapshotCountOf(project.dir);
      const pending = host.controller.submitVerified(removeCommand(FEATURE_A), proof, "edit", null, {
        beforeFeature: features[0]
      });

      // The attempt times out (ambiguous), the controller polls, the real
      // lookup answers `unclaimed`, and the client re-sends the IDENTICAL
      // request under the SAME operation id.
      const result = await pending;
      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") throw new Error("unreachable");

      const traffic = editorTraffic(wire);
      expect(traffic[0].method).toBe("POST");
      expect(traffic[1].method).toBe("GET");
      expect(traffic[1].url).toContain("/editor/operations/");
      expect(traffic[2].method).toBe("POST");
      expect(traffic[2].body).toBe(traffic[0].body); // byte-identical re-send
      expect(traffic[0].body).not.toBeNull();

      // The controller never reported a rejection.
      expect(host.conflicts).toEqual([]);

      // Exactly one snapshot, exactly one receipt: the server committed once.
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);
      const after = await readEditorDocument(host.api, project.projectId);
      expect(after.head).toBe(result.receipt.snapshotId);

      // Now let the ORIGINAL POST through. The server sees the same
      // operation id again and replays the receipt — no second snapshot.
      held.release();
      await waitFor(
        () => editorTraffic(wire).filter((call) => call.method === "POST" && call.status !== null).length >= 2,
        { description: "the held original POST to be answered", timeoutMs: 10_000 }
      );
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);
    } finally {
      for (const hold of holds) hold.release();
      disposeHost(host);
    }
  }, 60000);

  it("integration_retry_conflict_from_lock_timeout_is_not_a_rejection", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-seam-lock", scad: MODEL_SCAD });
    const features = [feature(project.projectId, FEATURE_A), feature(project.projectId, FEATURE_B)];
    await seedSidecar(project.dir, features);

    const host = createHost({
      baseUrl: server.baseUrl,
      projectId: project.projectId,
      fetchImpl: wire.fetchImpl,
      timeoutMs: SHORT_TIMEOUT_MS
    });
    const holds: FetchHold[] = [];
    const locks: HeldLock[] = [];
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

      const held = wire.holdNext((url, method) => method === "POST" && url.includes("/editor/commands"));
      holds.push(held);

      // The RETRY (the client's background re-send, the second POST) meets
      // real lock contention: the lock is taken before it is forwarded.
      wire.beforeNext(
        (url, method) => method === "POST" && url.includes("/editor/commands"),
        async () => {
          locks.push(await holdProjectLock(project.dir));
        }
      );

      const before = await snapshotCountOf(project.dir);
      const pending = host.controller.submitVerified(removeCommand(FEATURE_A), proof, "edit", null, {
        beforeFeature: features[0]
      });

      // The retry's real answer is a 409 from the lock wait.
      await waitFor(
        () => editorTraffic(wire).some((call) => call.method === "POST" && call.status === 409),
        { description: "the re-send to be refused with a 409 from the lock wait", timeoutMs: 40_000 }
      );
      const refused = editorTraffic(wire).find((call) => call.method === "POST" && call.status === 409);
      expect(refused).toBeDefined();
      expect(refused?.errorBody?.error_code).toBe("CONFLICT");
      // It is the LOCK's refusal, not some other 409.
      expect(refused?.errorBody?.message).toContain("could not acquire the");
      expect(refused?.errorBody?.message).not.toContain("base editor revision is stale");

      // The original now commits: the outcome resolves to `committed`
      // THROUGH THE CLAIM, not through the refused retry.
      await locks[0].release();
      held.release();

      const result = await pending;
      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") throw new Error("unreachable");

      // The controller never reported a rejection.
      expect(host.conflicts).toEqual([]);
      expect(await snapshotCountOf(project.dir)).toBe(before + 1);
    } finally {
      for (const lock of locks) await lock.release();
      for (const hold of holds) hold.release();
      disposeHost(host);
    }
  }, 90000);

  it("integration_superseded_receipt_from_second_writer_recovers", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-seam-superseded", scad: MODEL_SCAD });
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

      // The first writer's response is lost: the server committed, the writer
      // does not know yet.
      wire.dropNextResponse((url, method) => method === "POST" && url.includes("/editor/commands"));
      const before = await snapshotCountOf(project.dir);

      const pending = host.controller.submitVerified(removeCommand(FEATURE_A), proof, "edit", null, {
        beforeFeature: features[0]
      });

      // The first writer learns its receipt through the real poll and is
      // still `committing` — it waits for a coherent document read.
      await waitFor(() => host.controller.state().kind === "committing", {
        description: "the first writer to reach the committing state with its receipt",
        timeoutMs: 20_000
      });

      // A SECOND WRITER commits between that receipt and the first writer's
      // document read.
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
      const second = await writer.controller.submitVerified(removeCommand(FEATURE_B), proofB, "edit", null, {
        beforeFeature: features[1]
      });
      expect(second.kind).toBe("committed");
      if (second.kind !== "committed") throw new Error("unreachable");

      // The first writer's document read is superseded by the second writer's
      // commit: the read returns the NEWER revision.
      const superseded = await readEditorDocument(host.api, project.projectId);
      expect(superseded.editorRevision).toBe(second.receipt.editorRevision);

      const result = await pending;
      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") throw new Error("unreachable");

      // The first writer is still `committing` until its host reports the
      // read — then it LEAVES `committing`.
      expect(host.controller.state().kind).toBe("committing");
      host.controller.notifyDocumentRevision(superseded.editorRevision);
      expect(host.controller.state().kind).toBe("idle");

      // Its cursor moved from its receipt, and the redo stack is not
      // available any more: the external write made the entry stale.
      const history = host.controller.history();
      expect(history.entries).toHaveLength(1);
      expect(history.cursor).toBe(1);
      expect(history.entries[0].stale).toBe(true);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);
      expect(history.redoTarget).toBeNull();

      expect(await snapshotCountOf(project.dir)).toBe(before + 2);
    } finally {
      disposeHost(host);
      disposeHost(writer);
    }
  }, 60000);

  it("integration_ambiguous_operation_whose_every_resend_is_refused_stays_ambiguous", async () => {
    const project = await createProject(server.baseUrl, projects.dir, { name: "c5-carried-limit", scad: MODEL_SCAD });
    const features = [feature(project.projectId, FEATURE_A), feature(project.projectId, FEATURE_B)];
    await seedSidecar(project.dir, features);

    const host = createHost({
      baseUrl: server.baseUrl,
      projectId: project.projectId,
      fetchImpl: wire.fetchImpl,
      timeoutMs: SHORT_TIMEOUT_MS
    });
    const holds: FetchHold[] = [];
    const locks: HeldLock[] = [];
    let pending: Promise<unknown> = Promise.resolve(undefined);
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

      const held = wire.holdNext((url, method) => method === "POST" && url.includes("/editor/commands"));
      holds.push(held);

      const headBefore = await readProjectHeadLockFree(project.dir);

      // Every re-send meets the real lock and is refused BEFORE a claim is
      // reserved — so the lookup keeps answering `unclaimed`.
      wire.beforeNext(
        (url, method) => method === "POST" && url.includes("/editor/commands"),
        async () => {
          locks.push(await holdProjectLock(project.dir));
        }
      );

      let settled = false;
      pending = host.controller
        .submitVerified(removeCommand(FEATURE_A), proof, "edit", null, { beforeFeature: features[0] })
        .then((result) => {
          settled = true;
          return result;
        });

      // The re-send is refused by the real lock.
      await waitFor(
        () => editorTraffic(wire).some((call) => call.method === "POST" && call.status === 409),
        { description: "the re-send to be refused", timeoutMs: 40_000 }
      );
      const refused = editorTraffic(wire).find((call) => call.method === "POST" && call.status === 409);
      expect(refused?.errorBody?.error_code).toBe("CONFLICT");
      expect(refused?.errorBody?.message).toContain("could not acquire the");

      // The operation is still ambiguous and the controller is still polling.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(settled).toBe(false);
      const state = host.controller.state();
      expect(state.kind).toBe("resolving");
      if (state.kind !== "resolving") throw new Error("unreachable");
      expect(host.conflicts).toEqual([]);

      // No claim was ever reserved — the refusal happened before the claim.
      await expect(access(claimPathOf(project.dir, state.operationId))).rejects.toThrow();

      // The store is untouched: the head never moved. (Read off disk, without
      // the project lock — this case is deliberately holding that lock.)
      expect(await readProjectHeadLockFree(project.dir)).toBe(headBefore);
    } finally {
      for (const lock of locks) await lock.release();
      for (const hold of holds) hold.release();
      disposeHost(host);
      await pending.catch(() => undefined);
    }
  }, 90000);
});
