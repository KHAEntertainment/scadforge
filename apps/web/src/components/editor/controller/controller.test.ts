// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOLVING_MAX_DELAY_MS } from "./backoff.js";
import { TransactionController } from "./controller.js";
import {
  createInMemoryBroadcastChannelFactory,
  createRealTimer,
  createSequentialUuidSource,
  FakeEditorClient
} from "./testDoubles.js";
import type {
  AmbiguousCause,
  BeginInput,
  CancelReason,
  CommitOutcome,
  EditorProofResponse,
  EditorReceipt,
  GuardInputsSnapshot,
  TransactionControllerDeps
} from "./types.js";

const HEX64_A = "a".repeat(64);
const HEX64_B = "b".repeat(64);
const HEX64_C = "c".repeat(64);

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeDeps(overrides: Partial<TransactionControllerDeps> = {}): {
  deps: TransactionControllerDeps;
  client: FakeEditorClient;
} {
  const client = (overrides.client as FakeEditorClient | undefined) ?? new FakeEditorClient();
  const deps: TransactionControllerDeps = {
    projectId: "project-1",
    clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
    timer: createRealTimer(),
    uuid: createSequentialUuidSource(),
    broadcastChannelFactory: createInMemoryBroadcastChannelFactory(),
    onPeerCommitted: vi.fn(),
    ...overrides,
    client
  };
  return { deps, client };
}

function makeBeginInput(overrides: Partial<BeginInput> = {}): BeginInput {
  return {
    featureId: "feature-1",
    bindingVersion: 1,
    baseEditorRevision: HEX64_A,
    sourceFingerprint: HEX64_B,
    sidecarStatus: "ready",
    eligibility: null,
    freshProof: null,
    baseValue: 40,
    ...overrides
  };
}

function makeProof(overrides: Partial<EditorProofResponse> = {}): EditorProofResponse {
  return {
    version: 1,
    proofId: "proof-1",
    commandDigest: HEX64_C,
    baseEditorRevision: HEX64_A,
    expiresAt: "2026-01-01T00:05:00.000Z",
    ...overrides
  };
}

function makeReceipt(overrides: Partial<EditorReceipt> = {}): EditorReceipt {
  return {
    version: 1,
    projectId: "project-1",
    operationId: "op-1",
    requestDigest: "d".repeat(64),
    baseEditorRevision: HEX64_A,
    editorRevision: "e".repeat(64),
    snapshotId: "snap-1",
    values: {},
    sidecarDigest: "f".repeat(64),
    ...overrides
  };
}

function idleGuardInputs(overrides: Partial<GuardInputsSnapshot> = {}): GuardInputsSnapshot {
  return {
    sidecarStatus: "ready",
    sourceDirty: false,
    sourceConflict: false,
    paramsDirty: false,
    paramsSaving: false,
    agentTurnRunning: false,
    externalWriteUnsettled: false,
    ...overrides
  };
}

function definiteCommitted(receipt: EditorReceipt): CommitOutcome {
  return { kind: "definite", response: { version: 1, state: "committed", receipt } };
}

function definiteRejected(reason: "unclaimed" | "rejected" | "aborted" = "rejected"): CommitOutcome {
  return {
    kind: "definite",
    response: { version: 1, state: "definitely_not_committed", requestDigest: null, reason, error: null }
  };
}

function ambiguous(cause: AmbiguousCause = "network-error"): CommitOutcome {
  return { kind: "ambiguous", cause };
}

/** Drives a candidate to `preview-ok` by proposing then writing a matching port sample. */
function reachPreviewOk(controller: TransactionController, candidate: number, source: "drag" | "typed" = "drag"): void {
  const proposed = controller.propose(candidate, source);
  if (!proposed.ok || "noOp" in proposed) throw new Error("expected propose to advance, not no-op");
  const state = controller.state();
  if (state.kind !== "preview-pending") throw new Error(`expected preview-pending, got ${state.kind}`);
  controller.portWriter.write({ value: candidate, generation: state.portGeneration });
}

describe("TransactionController", () => {
  // ── begin / propose / no-op (spec §3.1, §3.5) ────────────────────────────

  it("controller_propose_advances_to_preview_pending", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    expect(controller.begin(makeBeginInput())).toEqual({ ok: true });

    const result = controller.propose(43, "drag");

    expect(result.ok).toBe(true);
    expect(controller.state().kind).toBe("preview-pending");
  });

  it("controller_noop_short_circuit_returns_to_idle_without_port_mutation", () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput({ baseValue: 40 }));

    const result = controller.propose(40, "drag");

    expect(result).toEqual({ ok: true, noOp: true });
    expect(controller.state()).toEqual({ kind: "idle" });
    expect(client.commits).toHaveLength(0);
  });

  it("controller_propose_with_equal_candidate_returns_to_idle_zero_writes", () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput({ baseValue: 12.5 }));

    const result = controller.propose(12.5, "typed");

    expect(result).toEqual({ ok: true, noOp: true });
    expect(controller.state().kind).toBe("idle");
    expect(client.commits).toHaveLength(0);
    expect(client.lookups).toHaveLength(0);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity]
  ])("propose refuses a non-finite candidate (%s) with no state change", (_label, candidate) => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput({ baseValue: 40 }));

    // NaN would also defeat the no-op guard above (`NaN === 40` is false),
    // so without this refusal a NaN candidate would reach preview-pending.
    const result = controller.propose(candidate, "typed");

    expect(result).toEqual({ ok: false, reason: "non-finite-candidate" });
    expect(controller.state()).toEqual({ kind: "gesture", begin: makeBeginInput({ baseValue: 40 }) });
    expect(client.commits).toHaveLength(0);
  });

  // ── begin guards (spec §3.3; AC 1, 4, 6) ──────────────────────────────────

  it("controller_begin_refuses_when_params_pending", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    controller.setGuardInputs(idleGuardInputs({ paramsDirty: true }));

    expect(controller.begin(makeBeginInput())).toEqual({ ok: false, reason: "params-pending" });
  });

  it("controller_begin_refuses_when_authority_corrupt", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    controller.setGuardInputs(idleGuardInputs({ sidecarStatus: "corrupt" }));

    expect(controller.begin(makeBeginInput())).toEqual({ ok: false, reason: "sidecar-unreadable" });
  });

  it("controller_begin_refuses_when_feature_eligibility_requires_proof_and_no_proof", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);

    const result = controller.begin(
      makeBeginInput({
        eligibility: { featureId: "feature-1", state: "requires-proof", reason: "changed" },
        freshProof: null
      })
    );

    expect(result).toEqual({ ok: false, reason: "proof-required" });
  });

  it("begin refuses when the only available proof has expired", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);

    const result = controller.begin(
      makeBeginInput({
        eligibility: { featureId: "feature-1", state: "requires-proof", reason: "changed" },
        freshProof: makeProof({ expiresAt: "2025-01-01T00:00:00.000Z" })
      })
    );

    expect(result).toEqual({ ok: false, reason: "proof-required" });
  });

  it("begin fails closed when the proof's expiresAt does not parse (GLM Q1)", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);

    // `Date.parse` returns NaN for garbage input; `clock() >= NaN` is always
    // false, which would otherwise let an unparseable proof through as
    // though it never expires.
    const result = controller.begin(
      makeBeginInput({
        eligibility: { featureId: "feature-1", state: "requires-proof", reason: "changed" },
        freshProof: makeProof({ expiresAt: "not-a-date" })
      })
    );

    expect(result).toEqual({ ok: false, reason: "proof-required" });
  });

  it("begin succeeds when eligibility requires proof and a fresh proof is supplied", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);

    const result = controller.begin(
      makeBeginInput({
        eligibility: { featureId: "feature-1", state: "requires-proof", reason: "changed" },
        freshProof: makeProof({ expiresAt: "2026-01-01T00:05:00.000Z" })
      })
    );

    expect(result).toEqual({ ok: true });
  });

  it("begin refuses an unsupported feature", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);

    const result = controller.begin(
      makeBeginInput({ eligibility: { featureId: "feature-1", state: "unsupported", reason: "no binding" } })
    );

    expect(result).toEqual({ ok: false, reason: "feature-unsupported" });
  });

  it("begin refuses when not idle", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());

    expect(controller.begin(makeBeginInput())).toEqual({ ok: false, reason: "not-idle" });
  });

  // ── Failure A / Failure B ─────────────────────────────────────────────────

  it("controller_finalize_waits_for_port_state_not_status_event", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "typed");
    const state = controller.state();
    if (state.kind !== "preview-pending") throw new Error("expected preview-pending");

    client.queueCommitOutcome(definiteCommitted(makeReceipt()));
    let settled = false;
    const finalizePromise = controller.finalize(makeProof()).then((result) => {
      settled = true;
      return result;
    });

    // A status-event-only signal would never arrive here; only the port does.
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(client.commits).toHaveLength(0);

    controller.portWriter.write({ value: 43, generation: state.portGeneration });
    const result = await finalizePromise;

    expect(settled).toBe(true);
    expect(result.kind).toBe("committed");
    expect(client.commits).toHaveLength(1);
  });

  it("controller_finalize_strands_when_port_lags_release_can_recover", async () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "drag");
    const state = controller.state();
    if (state.kind !== "preview-pending") throw new Error("expected preview-pending");

    const finalizePromise = controller.finalize(makeProof());
    controller.portWriter.fail(state.portGeneration);
    const result = await finalizePromise;

    expect(result).toEqual({ kind: "preview-failed" });
    expect(controller.state().kind).toBe("preview-failed");

    // Recovery: cancel, then a fresh begin never refuses because of the
    // stranded transaction — that is Failure A's actual defect, fixed.
    controller.cancel("pointercancel");
    expect(controller.state()).toEqual({ kind: "idle" });
    expect(controller.begin(makeBeginInput())).toEqual({ ok: true });
  });

  // ── cancel reasons (spec §3.4) ────────────────────────────────────────────

  const CANCEL_REASONS: CancelReason[] = [
    "escape",
    "pointercancel",
    "lostpointercapture",
    "window-blur",
    "tool-change",
    "unmount"
  ];

  it("controller_cancel_each_of_six_reasons_zero_log_entry_zero_network", () => {
    for (const reason of CANCEL_REASONS) {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      controller.propose(43, "drag");

      controller.cancel(reason);

      expect(controller.state(), `reason=${reason}`).toEqual({ kind: "idle" });
      expect(client.commits, `reason=${reason}`).toHaveLength(0);
      expect(client.lookups, `reason=${reason}`).toHaveLength(0);
    }
  });

  it("cancel while idle is a no-op", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);

    controller.cancel("escape");

    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("cancel observably transitions through cancelling before idle", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "drag");

    const observed: string[] = [];
    controller.subscribe(() => observed.push(controller.state().kind));

    controller.cancel("escape");

    expect(observed).toEqual(["cancelling", "idle"]);
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("propose refuses while a finalize/submitVerified call is already waiting on the port", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "typed");
    const state = controller.state();
    if (state.kind !== "preview-pending") throw new Error("expected preview-pending");

    client.queueCommitOutcome(definiteCommitted(makeReceipt()));
    const finalizePromise = controller.finalize(makeProof());

    // A later propose must not be allowed to swap the candidate out from
    // under the waiting finalize (spec §3.3: "candidate equals the latest
    // port value").
    const result = controller.propose(44, "typed");

    expect(result).toEqual({ ok: false, reason: "finalize-pending" });

    controller.portWriter.write({ value: 43, generation: state.portGeneration });
    const outcome = await finalizePromise;
    expect(outcome.kind).toBe("committed");
  });

  // ── commit (spec §5–§6.3, Tech-Lead R1–R2 rulings) ───────────────────────

  it("controller_commit_sends_exactly_one_post_per_accepted_receipt", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));

    const result = await controller.finalize(makeProof());

    expect(result.kind).toBe("committed");
    expect(client.commits).toHaveLength(1);
    expect(client.commits[0].request.operationId).toBe("op-1");
  });

  it("a new finalize after a definite rejection mints a new operation ID", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteRejected("rejected"));
    await controller.finalize(makeProof());
    const firstId = client.commits[0].request.operationId;

    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 44);
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));
    await controller.finalize(makeProof());
    const secondId = client.commits[1].request.operationId;

    expect(secondId).not.toBe(firstId);
  });

  it("detach synchronously before the first commit() response settles still detaches cleanly", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));

    const resultPromise = controller.finalize(makeProof());
    // No await yet — the fake client's commit() promise has not resolved.
    const operationId = controller.detach();

    expect(operationId).toBe(client.commits[0].request.operationId);
    expect(controller.state()).toEqual({ kind: "idle" });
    const result = await resultPromise;
    expect(result).toEqual({ kind: "detached", operationId });
  });

  it("detach settles a finalize still waiting on the port (preview-pending) as cancelled", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "typed");
    const state = controller.state();
    if (state.kind !== "preview-pending") throw new Error("expected preview-pending");

    const finalizePromise = controller.finalize(makeProof());

    const operationId = controller.detach();

    // No operation was ever minted — the wait was abandoned before any POST.
    expect(operationId).toBeNull();
    expect(controller.state()).toEqual({ kind: "idle" });
    const result = await finalizePromise;
    expect(result).toEqual({ kind: "cancelled" });
    expect(client.commits).toHaveLength(0);

    // A later port write for the abandoned wait must not resurrect it.
    controller.portWriter.write({ value: 43, generation: state.portGeneration });
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  describe("resolving backoff (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("controller_commit_idempotent_replay_returns_original_receipt", async () => {
      // Controller-side meaning of "idempotent replay": the controller never
      // sends a second POST for the same attempt. When the first commit()
      // is transport-ambiguous, the controller's own "retry" IS the
      // resolving poll — GET .../operations/:operationId under the SAME
      // operation ID — and the server's replay guarantee means that poll
      // can return the ORIGINAL receipt for a commit that actually landed.
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      const receipt = makeReceipt({ operationId: "op-1" });
      client.queueCommitOutcome(ambiguous("network-error"));
      client.queueLookupOutcome(definiteCommitted(receipt));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result).toEqual({ kind: "committed", receipt });
      // Exactly one POST was ever sent; the poll is not a second POST.
      expect(client.commits).toHaveLength(1);
      expect(client.lookups).toHaveLength(1);
      expect(client.lookups[0].operationId).toBe(client.commits[0].request.operationId);
      expect(receipt.operationId).toBe(client.commits[0].request.operationId);
    });

    it("R3 poll path: a committed answer arriving via a resolving poll also stays committing until coherent", async () => {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      const receipt = makeReceipt({ editorRevision: "9".repeat(64) });
      client.queueCommitOutcome(ambiguous("network-error"));
      client.queueLookupOutcome(definiteCommitted(receipt));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();
      expect(controller.state().kind).toBe("resolving");

      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result).toEqual({ kind: "committed", receipt });
      // The receipt arrived through a POLL, not the initial response, but
      // R3's coherence wait applies identically: stay committing until the
      // host confirms this exact editorRevision.
      expect(controller.state()).toMatchObject({ kind: "committing", receipt });

      controller.notifyDocumentRevision("stale".padEnd(64, "0"));
      expect(controller.state().kind).toBe("committing");

      controller.notifyDocumentRevision(receipt.editorRevision);
      expect(controller.state()).toEqual({ kind: "idle" });
    });

    it("controller_commit_ambiguous_transition_to_resolving_then_idle", async () => {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      client.queueCommitOutcome(ambiguous("timeout"));
      client.queueLookupOutcome(definiteRejected("rejected"));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();
      expect(controller.state().kind).toBe("resolving");

      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result).toEqual({ kind: "rejected", reason: "rejected", error: null });
      expect(controller.state()).toEqual({ kind: "idle" });
    });

    it("controller_resolving_polls_until_known_with_exponential_backoff", async () => {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      client.queueCommitOutcome(ambiguous("server-unknown"));
      client.queueLookupOutcome(ambiguous("server-unknown"));
      client.queueLookupOutcome(ambiguous("server-unknown"));
      client.queueLookupOutcome(definiteCommitted(makeReceipt()));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();
      expect(controller.state().kind).toBe("resolving");
      expect(client.lookups).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(500); // attempt 1 delay
      expect(client.lookups).toHaveLength(1);
      expect(controller.state()).toMatchObject({ kind: "resolving", attempt: 2 });

      await vi.advanceTimersByTimeAsync(1000); // attempt 2 delay (500 * 2)
      expect(client.lookups).toHaveLength(2);
      expect(controller.state()).toMatchObject({ kind: "resolving", attempt: 3 });

      await vi.advanceTimersByTimeAsync(2000); // attempt 3 delay (500 * 4)
      const result = await resultPromise;
      expect(result.kind).toBe("committed");
      expect(client.lookups).toHaveLength(3);
      // Every poll reused the SAME operation ID minted at finalize.
      const ids = new Set([client.commits[0].request.operationId, ...client.lookups.map((l) => l.operationId)]);
      expect(ids.size).toBe(1);
    });

    it("controller_resolving_unknown_is_never_presented_as_rejected", async () => {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      client.queueCommitOutcome(ambiguous("server-unknown"));
      client.queueLookupOutcome(ambiguous("server-unknown"));
      client.queueLookupOutcome(definiteRejected("aborted"));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(500);
      expect(controller.state().kind).toBe("resolving"); // still ambiguous — never "rejected" here

      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      // Only the TRUE definite rejection produces "rejected" — never the
      // intermediate "unknown"/ambiguous polls.
      expect(result).toEqual({ kind: "rejected", reason: "aborted", error: null });
    });

    it("detach stops polling and returns the operation ID", async () => {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      client.queueCommitOutcome(ambiguous("network-error"));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();
      expect(controller.state().kind).toBe("resolving");

      const operationId = controller.detach();

      expect(operationId).toBe(client.commits[0].request.operationId);
      expect(controller.state()).toEqual({ kind: "idle" });
      const result = await resultPromise;
      expect(result).toEqual({ kind: "detached", operationId });

      // Polling truly stopped: advancing time raises no further lookups.
      await vi.advanceTimersByTimeAsync(RESOLVING_MAX_DELAY_MS * 2);
      expect(client.lookups).toHaveLength(0);
    });

    it("cancel is a no-op mid-commit (resolving)", async () => {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      client.queueCommitOutcome(ambiguous("network-error"));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();
      expect(controller.state().kind).toBe("resolving");

      controller.cancel("escape");
      expect(controller.state().kind).toBe("resolving"); // unaffected

      controller.cancel("tool-change");
      expect(controller.state().kind).toBe("resolving"); // still unaffected

      // Clean up without leaking a pending timer/promise.
      controller.detach();
      await resultPromise;
    });

    it("unmount mid-commit detaches instead of abandoning silently", async () => {
      const { deps, client } = makeDeps();
      const controller = new TransactionController(deps);
      controller.begin(makeBeginInput());
      reachPreviewOk(controller, 43);
      client.queueCommitOutcome(ambiguous("network-error"));

      const resultPromise = controller.finalize(makeProof());
      await flushMicrotasks();
      expect(controller.state().kind).toBe("resolving");

      controller.cancel("unmount");

      const result = await resultPromise;
      expect(result.kind).toBe("detached");
      expect(controller.state()).toEqual({ kind: "idle" });
    });
  });

  // ── R3: committing → idle waits for document coherence ──────────────────

  it("stays committing (port locked) until a matching document revision is notified", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    const receipt = makeReceipt({ editorRevision: "1".repeat(64) });
    client.queueCommitOutcome(definiteCommitted(receipt));

    const result = await controller.finalize(makeProof());

    expect(result).toEqual({ kind: "committed", receipt });
    expect(controller.state()).toMatchObject({ kind: "committing", receipt });

    controller.notifyDocumentRevision("2".repeat(64)); // a stale/unrelated revision
    expect(controller.state().kind).toBe("committing");

    controller.notifyDocumentRevision(receipt.editorRevision);
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("a display failure before coherence disables display-recovering; recovery returns to idle", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));
    await controller.finalize(makeProof());

    controller.notifyDisplayFailure();

    expect(controller.state()).toEqual({ kind: "disabled", reason: "display-recovering" });

    controller.notifyDisplayRecovered();

    expect(controller.state()).toEqual({ kind: "idle" });
  });

  // ── R4: external-write invalidation mid-gesture ──────────────────────────

  it("an external write mid-gesture aborts to idle with zero network, then disables", () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "drag");

    controller.setGuardInputs(idleGuardInputs({ externalWriteUnsettled: true }));

    expect(controller.state()).toEqual({ kind: "disabled", reason: "external-write-unsettled" });
    expect(client.commits).toHaveLength(0);
  });

  it("does not interrupt an in-flight commit on external-write-unsettled", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));
    const resultPromise = controller.finalize(makeProof());

    controller.setGuardInputs(idleGuardInputs({ externalWriteUnsettled: true }));

    // Still committing (port locked, awaiting coherence) — untouched.
    expect(controller.state().kind).toBe("committing");
    await resultPromise;
  });

  // ── disabled reasons (spec §10.2 Q3, amended — one test per reason) ─────

  it.each([
    ["sidecar-unreadable", { sidecarStatus: "corrupt" as const }],
    ["source-dirty", { sourceDirty: true }],
    ["params-pending", { paramsDirty: true }],
    ["agent-turn-running", { agentTurnRunning: true }],
    ["external-write-unsettled", { externalWriteUnsettled: true }]
  ] as const)("disables with reason %s", (reason, patch) => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);

    controller.setGuardInputs(idleGuardInputs(patch));

    expect(controller.state()).toEqual({ kind: "disabled", reason });
  });

  it("does not notify subscribers when a guard-input push leaves the disabled reason unchanged (GLM A5)", () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    controller.setGuardInputs(idleGuardInputs({ paramsDirty: true }));
    expect(controller.state()).toEqual({ kind: "disabled", reason: "params-pending" });

    const listener = vi.fn();
    controller.subscribe(listener);

    // A second, semantically-identical push (e.g. an unrelated re-render
    // upstream) must not produce a fresh object or a notification.
    controller.setGuardInputs(idleGuardInputs({ paramsDirty: true }));

    expect(listener).not.toHaveBeenCalled();
    expect(controller.state()).toEqual({ kind: "disabled", reason: "params-pending" });
  });

  // ── Q4 second-tab detection ──────────────────────────────────────────────

  it("a peer tab's committed broadcast triggers the injected refresh callback", async () => {
    const sharedFactory = createInMemoryBroadcastChannelFactory();
    const { deps: depsA, client: clientA } = makeDeps({ broadcastChannelFactory: sharedFactory });
    const onPeerCommitted = vi.fn();
    const { deps: depsB } = makeDeps({ broadcastChannelFactory: sharedFactory, onPeerCommitted });

    const controllerA = new TransactionController(depsA);
    new TransactionController(depsB); // establishes the peer listener

    controllerA.begin(makeBeginInput());
    reachPreviewOk(controllerA, 43);
    clientA.queueCommitOutcome(definiteCommitted(makeReceipt()));
    await controllerA.finalize(makeProof());

    expect(onPeerCommitted).toHaveBeenCalledTimes(1);
  });
});
