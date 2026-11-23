// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOLVING_MAX_DELAY_MS } from "./backoff.js";
import { TransactionController } from "./controller.js";
import { createPendingReceiptStore } from "./pendingReceipts.js";
import type { TransactionPort } from "./port.js";
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
  ControllerState,
  EditorFeature,
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
    // Every test gets its own pending-receipt store; none relies on the shared page-lifetime default.
    pendingReceipts: createPendingReceiptStore(),
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

    // The port write is what moves the transaction to `preview-ok` — observed
    // by state name on the way to `committing`, not just inferred from the commit.
    const observed: string[] = [];
    controller.subscribe(() => observed.push(controller.state().kind));
    controller.portWriter.write({ value: 43, generation: state.portGeneration });
    const result = await finalizePromise;

    expect(observed.slice(0, 2)).toEqual(["preview-ok", "committing"]);
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

      // Every reason is observed as `cancelling` (carrying that reason) and
      // then `idle`, never skipping a step.
      const observed: ControllerState[] = [];
      controller.subscribe(() => observed.push(controller.state()));

      controller.cancel(reason);

      expect(observed, `reason=${reason}`).toEqual([{ kind: "cancelling", reason }, { kind: "idle" }]);
      expect(controller.state(), `reason=${reason}`).toEqual({ kind: "idle" });
      expect(client.commits, `reason=${reason}`).toHaveLength(0);
      expect(client.lookups, `reason=${reason}`).toHaveLength(0);
      // No log entry, and the port is back in its reset state — asserted on the port itself.
      expect(controller.history().entries, `reason=${reason}`).toHaveLength(0);
      expect((controller.portWriter as TransactionPort).read().status, `reason=${reason}`).toBe("empty");
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

      // A read that started before the commit landed shows the receipt's
      // pre-image; it must not release the port lock.
      controller.notifyDocumentRevision(receipt.baseEditorRevision);
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

    // A read that started before the commit landed shows the receipt's
    // pre-image (a revision that is neither the receipt's nor a newer one).
    controller.notifyDocumentRevision(receipt.baseEditorRevision);
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

// ═══════════════════════════════════════════════════════════════════════════
// S3-C C3 — session log, undo/redo traversal, navigation receipts
// ═══════════════════════════════════════════════════════════════════════════

const REV = (c: string): string => c.repeat(64);
const R1 = REV("1");
const R2 = REV("2");
const R3 = REV("3");
const R4 = REV("4");

function makeFeature(featureId: string, bindingVersion = 1, parameter = "width"): EditorFeature {
  return {
    featureId,
    label: featureId,
    projectId: "project-1",
    createdAtRevision: HEX64_A,
    sourceFingerprint: HEX64_B,
    bindingVersion,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter, axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } }
  };
}

/** The receipt for the NEXT commit the fake client will see (operation IDs are sequential: op-1, op-2, ...). */
function nextReceipt(client: FakeEditorClient, base: string, revision: string, overrides: Partial<EditorReceipt> = {}): EditorReceipt {
  return makeReceipt({
    operationId: `op-${client.commits.length + 1}`,
    baseEditorRevision: base,
    editorRevision: revision,
    snapshotId: `snap-${revision.slice(0, 2)}`,
    sidecarDigest: revision,
    ...overrides
  });
}

/** One accepted value edit, run to coherence (idle again). */
async function commitEdit(
  controller: TransactionController,
  client: FakeEditorClient,
  edit: { from: number; to: number; base: string; revision: string }
): Promise<EditorReceipt> {
  const receipt = nextReceipt(client, edit.base, edit.revision);
  controller.begin(makeBeginInput({ baseValue: edit.from }));
  reachPreviewOk(controller, edit.to);
  client.queueCommitOutcome(definiteCommitted(receipt));
  const result = await controller.finalize(makeProof({ baseEditorRevision: edit.base }));
  expect(result.kind).toBe("committed");
  controller.notifyDocumentRevision(edit.revision);
  expect(controller.state()).toEqual({ kind: "idle" });
  return receipt;
}

/** One accepted setup command, run to coherence. */
async function commitSetup(
  controller: TransactionController,
  client: FakeEditorClient,
  setup: { command: Parameters<TransactionController["submitVerified"]>[0]; before: EditorFeature | null; base: string; revision: string }
): Promise<EditorReceipt> {
  const receipt = nextReceipt(client, setup.base, setup.revision);
  client.queueCommitOutcome(definiteCommitted(receipt));
  const result = await controller.submitVerified(setup.command, makeProof({ baseEditorRevision: setup.base }), "setup", null, {
    beforeFeature: setup.before
  });
  expect(result.kind).toBe("committed");
  controller.notifyDocumentRevision(setup.revision);
  expect(controller.state()).toEqual({ kind: "idle" });
  return receipt;
}

/** prepare → (host verifies) → submit, accepted, run to coherence. */
async function traverse(
  controller: TransactionController,
  client: FakeEditorClient,
  direction: "undo" | "redo",
  revision: string
): Promise<{ request: ReturnType<TransactionController["prepareTraversal"]> & { ok: true }; result: Awaited<ReturnType<TransactionController["submitTraversal"]>> }> {
  const prepared = controller.prepareTraversal(direction);
  if (!prepared.ok) throw new Error(`prepareTraversal(${direction}) refused: ${prepared.reason}`);
  client.queueCommitOutcome(definiteCommitted(nextReceipt(client, prepared.request.baseEditorRevision, revision)));
  const result = await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: prepared.request.baseEditorRevision }));
  expect(result.kind).toBe("committed");
  controller.notifyDocumentRevision(revision);
  return { request: prepared, result };
}

/** Two edits (40→43, 43→46), then one accepted undo: cursor 1 of 2, redo available. */
async function makeUndoneSession(): Promise<{ controller: TransactionController; client: FakeEditorClient; deps: TransactionControllerDeps }> {
  const { deps, client } = makeDeps();
  const controller = new TransactionController(deps);
  await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
  await commitEdit(controller, client, { from: 43, to: 46, base: R1, revision: R2 });
  await traverse(controller, client, "undo", R3);
  return { controller, client, deps };
}

function summary(controller: TransactionController): { cursor: number; entries: number; canUndo: boolean; canRedo: boolean; stale: number } {
  const h = controller.history();
  return { cursor: h.cursor, entries: h.entries.length, canUndo: h.canUndo, canRedo: h.canRedo, stale: h.entries.filter((e) => e.stale).length };
}

describe("TransactionController session log and navigation receipts (C3)", () => {
  // ── spec §9.1: navigation receipts ───────────────────────────────────────

  it("controller_navigation_during_committing_records_pending_receipt", async () => {
    const { deps, client } = makeDeps();
    const store = deps.pendingReceipts!;
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));

    const resultPromise = controller.finalize(makeProof());
    expect(controller.state().kind).toBe("committing");
    const operationId = controller.detach(); // the user switches projects mid-commit

    expect(operationId).toBe("op-1");
    expect(store.list("project-1")).toEqual([{ projectId: "project-1", operationId: "op-1", intent: "edit", traversal: null }]);
    expect(store.list("project-2")).toEqual([]);
    expect(await resultPromise).toEqual({ kind: "detached", operationId: "op-1" });
    // The late response never reaches this controller's log.
    await flushMicrotasks();
    expect(controller.history().entries).toHaveLength(0);
  });

  it("navigation during resolving records the pending receipt too, including a traversal's identity", async () => {
    const { deps, client } = makeDeps();
    const store = deps.pendingReceipts!;
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    const prepared = controller.prepareTraversal("undo");
    if (!prepared.ok) throw new Error("expected a traversal");
    client.queueCommitOutcome(ambiguous());
    const resultPromise = controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R1 }));
    await flushMicrotasks();
    expect(controller.state().kind).toBe("resolving");

    const operationId = controller.detach();

    expect(operationId).toBe("op-2");
    expect(store.list("project-1")).toEqual([
      { projectId: "project-1", operationId: "op-2", intent: "undo", traversal: { operationId: "op-1", direction: "undo" } }
    ]);
    expect(await resultPromise).toEqual({ kind: "detached", operationId: "op-2" });
  });

  it("controller_navigation_return_reconciles_pending_receipt", async () => {
    const { deps, client } = makeDeps();
    const store = deps.pendingReceipts!;
    const left = new TransactionController(deps);
    left.begin(makeBeginInput());
    reachPreviewOk(left, 43);
    client.queueCommitOutcome(ambiguous());
    const resultPromise = left.finalize(makeProof());
    await flushMicrotasks();
    left.detach();
    await resultPromise;
    left.dispose();

    // Back on the project: a new controller (same page-lifetime client).
    const receipt = makeReceipt({ operationId: "op-1" });
    client.queueLookupOutcome(definiteCommitted(receipt));
    const onPendingReconciled = vi.fn();
    const returned = new TransactionController({ ...deps, onPendingReconciled });
    await flushMicrotasks();

    expect(client.lookups).toEqual([{ projectId: "project-1", operationId: "op-1" }]);
    expect(onPendingReconciled).toHaveBeenCalledTimes(1);
    expect(onPendingReconciled).toHaveBeenCalledWith({ operationId: "op-1", outcome: "committed", receipt });
    expect(store.list("project-1")).toEqual([]);
    // Reconciliation is reported, not painted: the new controller's own state and log are untouched.
    expect(returned.state()).toEqual({ kind: "idle" });
    expect(returned.history().entries).toHaveLength(0);
  });

  it("a definitely-not-committed lookup on return is reported and dropped", async () => {
    const { deps, client } = makeDeps();
    const store = deps.pendingReceipts!;
    store.record({ projectId: "project-1", operationId: "op-9", intent: "edit", traversal: null });
    client.queueLookupOutcome(definiteRejected("unclaimed"));
    const onPendingReconciled = vi.fn();

    new TransactionController({ ...deps, onPendingReconciled });
    await flushMicrotasks();

    expect(onPendingReconciled).toHaveBeenCalledWith({ operationId: "op-9", outcome: "not-committed", reason: "unclaimed" });
    expect(store.has("project-1", "op-9")).toBe(false);
  });

  it("a pending receipt is never looked up, reported or painted for another project", async () => {
    const { deps, client } = makeDeps();
    const store = deps.pendingReceipts!;
    store.record({ projectId: "project-1", operationId: "op-1", intent: "edit", traversal: null });
    const onPendingReconciled = vi.fn();

    const other = new TransactionController({ ...deps, projectId: "project-2", onPendingReconciled });
    await flushMicrotasks();

    expect(client.lookups).toEqual([]);
    expect(onPendingReconciled).not.toHaveBeenCalled();
    expect(store.has("project-1", "op-1")).toBe(true);
    expect(other.history().entries).toHaveLength(0);
  });

  it("a reconciliation lookup that resolves after dispose() calls nothing and keeps the record", async () => {
    const { deps, client } = makeDeps();
    const store = deps.pendingReceipts!;
    store.record({ projectId: "project-1", operationId: "op-1", intent: "edit", traversal: null });
    const resolveLookup = client.queueDeferredLookup();
    const onPendingReconciled = vi.fn();
    const controller = new TransactionController({ ...deps, onPendingReconciled });
    await flushMicrotasks();
    expect(client.lookups).toHaveLength(1);

    controller.dispose();
    resolveLookup(definiteCommitted(makeReceipt({ operationId: "op-1" })));
    await flushMicrotasks();

    expect(onPendingReconciled).not.toHaveBeenCalled();
    expect(store.has("project-1", "op-1")).toBe(true); // a later controller can still reconcile it
  });

  it("an ambiguous reconciliation lookup keeps the record pending and polls again, never treating it as rejected", async () => {
    vi.useFakeTimers();
    try {
      const { deps, client } = makeDeps({ timer: createRealTimer() });
      const store = deps.pendingReceipts!;
      store.record({ projectId: "project-1", operationId: "op-1", intent: "edit", traversal: null });
      client.queueLookupOutcome({ kind: "ambiguous", cause: "server-unknown" });
      const receipt = makeReceipt({ operationId: "op-1" });
      client.queueLookupOutcome(definiteCommitted(receipt));
      const onPendingReconciled = vi.fn();

      new TransactionController({ ...deps, onPendingReconciled });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.lookups).toHaveLength(1);
      expect(onPendingReconciled).not.toHaveBeenCalled();
      expect(store.has("project-1", "op-1")).toBe(true);

      await vi.advanceTimersByTimeAsync(RESOLVING_MAX_DELAY_MS);

      expect(client.lookups).toHaveLength(2);
      expect(onPendingReconciled).toHaveBeenCalledWith({ operationId: "op-1", outcome: "committed", receipt });
      expect(store.has("project-1", "op-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── spec §9.1: invalidation, undo/redo, display failure, reload ──────────

  it("controller_external_write_invalidates_stale_cursor_clears_redo", async () => {
    const { controller } = await makeUndoneSession();
    expect(summary(controller)).toEqual({ cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 });

    // C1's invalidate() → the host pushes externalWriteUnsettled.
    controller.setGuardInputs(idleGuardInputs({ externalWriteUnsettled: true }));

    // Redo is gone, every remaining entry is stale, undo is unavailable.
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: false, canRedo: false, stale: 1 });
    expect(controller.history().undoTarget).toBeNull();
    expect(controller.prepareTraversal("undo")).toEqual({ ok: false, reason: "disabled" }); // external-write-unsettled disables the gesture

    controller.setGuardInputs(idleGuardInputs());
    expect(controller.prepareTraversal("undo")).toEqual({ ok: false, reason: "stale-log" });
    expect(controller.prepareTraversal("redo")).toEqual({ ok: false, reason: "nothing-to-redo" });
  });

  it("a re-read showing a revision other than the last receipt's invalidates the same way", async () => {
    const { controller } = await makeUndoneSession();

    controller.notifyDocumentRevision(R4); // R3 was our last receipt

    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: false, canRedo: false, stale: 1 });
  });

  it("controller_undo_submits_traversal_command_with_original_operationId", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });

    const prepared = controller.prepareTraversal("undo");
    expect(prepared).toEqual({
      ok: true,
      request: {
        version: 1,
        baseEditorRevision: R1,
        command: { kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 40 },
        intent: "undo",
        traversal: { operationId: "op-1", direction: "undo" }
      }
    });
    if (!prepared.ok) return;
    client.queueCommitOutcome(definiteCommitted(nextReceipt(client, R1, R2)));
    await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R1 }));

    const sent = client.commits[1].request;
    expect(sent.intent).toBe("undo");
    expect(sent.command).toEqual({ kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 40 });
    expect(sent.traversal).toEqual({ operationId: "op-1", direction: "undo" }); // the ORIGINAL operation's ID
    expect(sent.operationId).toBe("op-2"); // the traversal commit has its own ID
    expect(sent.baseEditorRevision).toBe(R1);
    // The cursor moved back once, the undone entry is retained for redo, nothing was appended.
    expect(summary(controller)).toEqual({ cursor: 0, entries: 1, canUndo: false, canRedo: true, stale: 0 });
  });

  it("controller_redo_submits_traversal_command_with_original_operationId", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    await traverse(controller, client, "undo", R2);

    const { request } = await traverse(controller, client, "redo", R3);

    expect(request.request).toEqual({
      version: 1,
      baseEditorRevision: R2,
      command: { kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 43 },
      intent: "redo",
      traversal: { operationId: "op-1", direction: "redo" }
    });
    const sent = client.commits[2].request;
    expect(sent.intent).toBe("redo");
    expect(sent.traversal).toEqual({ operationId: "op-1", direction: "redo" });
    expect(sent.operationId).toBe("op-3");
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: true, canRedo: false, stale: 0 });
  });

  it("controller_stale_precondition_on_undo_does_not_move_cursor", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    const before = controller.history();
    const prepared = controller.prepareTraversal("undo");
    if (!prepared.ok) throw new Error("expected a traversal");
    // The server's precondition check fails (CONFLICT): a definite rejection.
    client.queueCommitOutcome(definiteRejected("rejected"));

    const result = await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R1 }));

    expect(result).toMatchObject({ kind: "rejected", reason: "rejected" });
    expect(controller.history()).toBe(before); // not even a fresh snapshot object
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: true, canRedo: false, stale: 0 });
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("controller_accepted_receipt_plus_display_failure_clears_redo_for_next_gesture", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    await commitEdit(controller, client, { from: 43, to: 46, base: R1, revision: R2 });
    // An accepted undo whose display then fails, before the document is coherent.
    const prepared = controller.prepareTraversal("undo");
    if (!prepared.ok) throw new Error("expected a traversal");
    client.queueCommitOutcome(definiteCommitted(nextReceipt(client, R2, R3)));
    await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R2 }));
    expect(summary(controller)).toEqual({ cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 });

    controller.notifyDisplayFailure();

    // The cursor already moved from the receipt; redo is cleared for the next gesture.
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: true, canRedo: false, stale: 0 });
    expect(controller.state()).toEqual({ kind: "disabled", reason: "display-recovering" });
    expect(controller.begin(makeBeginInput())).toEqual({ ok: false, reason: "display-recovering" });
    expect(controller.prepareTraversal("redo")).toEqual({ ok: false, reason: "disabled" });

    // Recovery does not resurrect redo.
    controller.notifyDisplayRecovered();
    expect(controller.state()).toEqual({ kind: "idle" });
    expect(controller.prepareTraversal("redo")).toEqual({ ok: false, reason: "nothing-to-redo" });
    expect(controller.history().canUndo).toBe(true);
  });

  it("controller_reload_discards_session_cursor_history_remains_via_revert", async () => {
    const { deps, client } = makeDeps();
    const first = new TransactionController(deps);
    await commitEdit(first, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    // The accepted operation is durable: its snapshot is what Revert (the durable path) starts from.
    expect(first.history().entries[0].entry.snapshotId).toBe("snap-11");
    expect(first.history().canUndo).toBe(true);

    first.dispose(); // reload: the page and its controller are gone
    const reloaded = new TransactionController(makeDeps({ client }).deps);

    expect(reloaded.history().entries).toHaveLength(0);
    expect(summary(reloaded)).toEqual({ cursor: 0, entries: 0, canUndo: false, canRedo: false, stale: 0 });
    expect(reloaded.prepareTraversal("undo")).toEqual({ ok: false, reason: "nothing-to-undo" });
    expect(first.history().entries).toHaveLength(0); // and the old instance's log is gone too
  });

  // ── added tests (criterion 10) ───────────────────────────────────────────

  // Spec §5.3, one row per table row. Each starts from: two edits, then one
  // accepted undo (cursor 1 of 2, redo available).
  const SPEC_5_3_ROWS: Array<{
    row: string;
    act: (c: TransactionController, client: FakeEditorClient, deps: TransactionControllerDeps) => Promise<void>;
    expected: { cursor: number; entries: number; canUndo: boolean; canRedo: boolean; stale: number };
  }> = [
    {
      row: "accepted fresh edit/setup: append, advance, clear redo",
      act: async (c, client) => {
        await commitEdit(c, client, { from: 43, to: 50, base: R3, revision: R4 });
      },
      expected: { cursor: 2, entries: 2, canUndo: true, canRedo: false, stale: 0 }
    },
    {
      row: "accepted undo: move back once, keep the undone entry for redo",
      act: async (c, client) => {
        await traverse(c, client, "undo", R4);
      },
      expected: { cursor: 0, entries: 2, canUndo: false, canRedo: true, stale: 0 }
    },
    {
      row: "accepted redo: move forward once, redo preserved",
      act: async (c, client) => {
        await traverse(c, client, "redo", R4);
      },
      expected: { cursor: 2, entries: 2, canUndo: true, canRedo: false, stale: 0 }
    },
    {
      row: "no-op (candidate equals base): no append, no movement, redo unchanged",
      act: async (c) => {
        c.begin(makeBeginInput({ baseValue: 43 }));
        expect(c.propose(43, "typed")).toEqual({ ok: true, noOp: true });
      },
      expected: { cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 }
    },
    {
      row: "cancel (any of six reasons): no append, no movement, redo unchanged",
      act: async (c) => {
        c.begin(makeBeginInput({ baseValue: 43 }));
        c.propose(50, "drag");
        c.cancel("escape");
      },
      expected: { cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 }
    },
    {
      row: "failed final preview: no append, no movement, redo unchanged",
      act: async (c) => {
        c.begin(makeBeginInput({ baseValue: 43 }));
        c.propose(50, "drag");
        const state = c.state();
        if (state.kind !== "preview-pending") throw new Error("expected preview-pending");
        const finalizing = c.finalize(makeProof({ baseEditorRevision: R3 }));
        c.portWriter.fail(state.portGeneration);
        expect(await finalizing).toEqual({ kind: "preview-failed" });
      },
      expected: { cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 }
    },
    {
      row: "definite conflict/rejection: no append, no movement; unchanged until authority shows an external write",
      act: async (c, client) => {
        c.begin(makeBeginInput({ baseValue: 43 }));
        reachPreviewOk(c, 50);
        client.queueCommitOutcome(definiteRejected("rejected"));
        expect((await c.finalize(makeProof({ baseEditorRevision: R3 }))).kind).toBe("rejected");
      },
      expected: { cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 }
    },
    {
      row: "definite conflict/rejection, authority changed externally: invalidate stale entries, clear redo",
      act: async (c, client) => {
        c.begin(makeBeginInput({ baseValue: 43 }));
        reachPreviewOk(c, 50);
        client.queueCommitOutcome(definiteRejected("rejected"));
        await c.finalize(makeProof({ baseEditorRevision: R3 }));
        c.notifyDocumentRevision(R4); // the refreshed authority differs from our last receipt
      },
      expected: { cursor: 1, entries: 1, canUndo: false, canRedo: false, stale: 1 }
    },
    {
      row: "ambiguous response: frozen while resolving, moves exactly once on the accepted receipt",
      act: async (c, client) => {
        c.begin(makeBeginInput({ baseValue: 43 }));
        reachPreviewOk(c, 50);
        const frozen = c.history();
        client.queueCommitOutcome(ambiguous());
        client.queueLookupOutcome({ kind: "ambiguous", cause: "server-unknown" });
        client.queueLookupOutcome(definiteCommitted(nextReceipt(client, R3, R4)));
        vi.useFakeTimers();
        try {
          const finalizing = c.finalize(makeProof({ baseEditorRevision: R3 }));
          await vi.advanceTimersByTimeAsync(0);
          expect(c.state().kind).toBe("resolving");
          expect(c.history()).toBe(frozen); // frozen while resolving
          await vi.advanceTimersByTimeAsync(RESOLVING_MAX_DELAY_MS * 3);
          expect((await finalizing).kind).toBe("committed");
        } finally {
          vi.useRealTimers();
        }
        c.notifyDocumentRevision(R4);
      },
      expected: { cursor: 2, entries: 2, canUndo: true, canRedo: false, stale: 0 }
    },
    {
      row: "accepted receipt + display failure: cursor moves, redo cleared",
      act: async (c, client) => {
        c.begin(makeBeginInput({ baseValue: 43 }));
        reachPreviewOk(c, 50);
        client.queueCommitOutcome(definiteCommitted(nextReceipt(client, R3, R4)));
        await c.finalize(makeProof({ baseEditorRevision: R3 }));
        c.notifyDisplayFailure();
      },
      expected: { cursor: 2, entries: 2, canUndo: true, canRedo: false, stale: 0 }
    },
    {
      row: "navigation/reload: the in-memory log is discarded",
      act: async (c) => {
        c.detach();
      },
      expected: { cursor: 0, entries: 0, canUndo: false, canRedo: false, stale: 0 }
    },
    {
      row: "external source/params/binding write: invalidate stale undo, clear redo",
      act: async (c) => {
        c.setGuardInputs(idleGuardInputs({ externalWriteUnsettled: true }));
      },
      expected: { cursor: 1, entries: 1, canUndo: false, canRedo: false, stale: 1 }
    }
  ];

  it.each(SPEC_5_3_ROWS)("spec §5.3 row — $row", async ({ act, expected }) => {
    const { controller, client, deps } = await makeUndoneSession();
    expect(summary(controller)).toEqual({ cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 });

    await act(controller, client, deps);

    expect(summary(controller)).toEqual(expected);
  });

  it("the no-op, cancel and failed-preview rows leave the very same history snapshot (zero notifications to history readers)", async () => {
    const { controller } = await makeUndoneSession();
    const before = controller.history();

    controller.begin(makeBeginInput({ baseValue: 43 }));
    controller.propose(43, "typed"); // no-op
    controller.begin(makeBeginInput({ baseValue: 43 }));
    controller.propose(50, "drag");
    controller.cancel("window-blur");

    expect(controller.history()).toBe(before);
  });

  it("setup commands undo and redo through the same traversal path: put-feature (create)", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    const feature = makeFeature("feature-2");
    await commitSetup(controller, client, { command: { kind: "put-feature", feature }, before: null, base: HEX64_A, revision: R1 });

    const undo = await traverse(controller, client, "undo", R2);
    expect(undo.request.request.command).toEqual({ kind: "remove-feature", featureId: "feature-2", bindingVersion: 1 });
    expect(undo.request.request.traversal).toEqual({ operationId: "op-1", direction: "undo" });
    expect(client.commits[1].request.intent).toBe("undo");

    const redo = await traverse(controller, client, "redo", R3);
    expect(redo.request.request.command).toEqual({ kind: "put-feature", feature });
    expect(client.commits[2].request.intent).toBe("redo");
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: true, canRedo: false, stale: 0 });
  });

  it("setup commands undo and redo through the same traversal path: remove-feature", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    const removed = makeFeature("feature-3", 4);
    await commitSetup(controller, client, {
      command: { kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 },
      before: removed,
      base: HEX64_A,
      revision: R1
    });

    const undo = await traverse(controller, client, "undo", R2);
    expect(undo.request.request.command).toEqual({ kind: "put-feature", feature: removed });

    const redo = await traverse(controller, client, "redo", R3);
    expect(redo.request.request.command).toEqual({ kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 });
  });

  it("a wrong caller-supplied before-image fails safe: the server rejects and the cursor does not move", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    const wrongBefore = makeFeature("feature-3", 9); // not what the server recorded
    await commitSetup(controller, client, {
      command: { kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 },
      before: wrongBefore,
      base: HEX64_A,
      revision: R1
    });
    const prepared = controller.prepareTraversal("undo");
    if (!prepared.ok) throw new Error("expected a traversal");
    // The server compares the submitted command with ITS recorded inverse and refuses (VALIDATION_FAILED).
    client.queueCommitOutcome(definiteRejected("rejected"));

    const result = await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R1 }));

    expect(result.kind).toBe("rejected");
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: true, canRedo: false, stale: 0 });
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("an attempt to undo an undo is refused locally with no request sent", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    await traverse(controller, client, "undo", R2); // the undo's own operationId is op-2
    const sentBefore = client.commits.length;
    const before = controller.history();

    const undoOfUndo = await controller.submitVerified(
      { kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 43 },
      makeProof({ baseEditorRevision: R2 }),
      "undo",
      { operationId: "op-2", direction: "undo" }
    );
    const redoOfUndo = await controller.submitVerified(
      { kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 40 },
      makeProof({ baseEditorRevision: R2 }),
      "redo",
      { operationId: "op-2", direction: "redo" }
    );

    expect(undoOfUndo).toEqual({ kind: "refused", reason: "traversal-of-traversal" });
    expect(redoOfUndo).toEqual({ kind: "refused", reason: "traversal-of-traversal" });
    expect(client.commits).toHaveLength(sentBefore);
    expect(controller.history()).toBe(before);
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("an undo/redo naming no entry at the cursor, or a mismatched direction, is refused locally", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    const command = { kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 40 } as const;
    const proof = makeProof({ baseEditorRevision: R1 });

    expect(await controller.submitVerified(command, proof, "undo", { operationId: "op-404", direction: "undo" })).toEqual({
      kind: "refused",
      reason: "unknown-traversal-target"
    });
    expect(await controller.submitVerified(command, proof, "undo", { operationId: "op-1", direction: "redo" })).toEqual({
      kind: "refused",
      reason: "unknown-traversal-target"
    });
    expect(await controller.submitVerified(command, proof, "redo", { operationId: "op-1", direction: "redo" })).toEqual({
      kind: "refused",
      reason: "unknown-traversal-target" // nothing to redo yet: op-1 is applied, not undone
    });
    expect(await controller.submitVerified(command, proof, "undo", null)).toEqual({ kind: "refused", reason: "unknown-traversal-target" });
    expect(client.commits).toHaveLength(1);
  });

  it("superseded receipt: another tab's write R2 before the re-read — cursor moves from R1, entries go stale, redo clears, nothing waits for R1", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    await commitEdit(controller, client, { from: 43, to: 46, base: R1, revision: R2 });
    await traverse(controller, client, "undo", R3);
    expect(summary(controller).canRedo).toBe(true);

    // A fresh edit is accepted at R4, but the document re-read returns R5, another tab's write.
    controller.begin(makeBeginInput({ baseValue: 43 }));
    reachPreviewOk(controller, 50);
    client.queueCommitOutcome(definiteCommitted(nextReceipt(client, R3, R4)));
    const result = await controller.finalize(makeProof({ baseEditorRevision: R3 }));
    expect(result.kind).toBe("committed");
    expect(controller.state()).toMatchObject({ kind: "committing" });

    controller.notifyDocumentRevision(REV("5"));

    // The cursor moved from the R4 receipt (two entries: the surviving first edit and this one)...
    expect(controller.history().cursor).toBe(2);
    expect(controller.history().entries[1].entry.editorRevision).toBe(R4);
    // ...stale entries are invalidated, redo is cleared, and the controller did not wait for R4.
    expect(summary(controller)).toEqual({ cursor: 2, entries: 2, canUndo: false, canRedo: false, stale: 2 });
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("a read equal to the in-flight receipt's pre-image (a stale pre-commit read) is ignored while committing", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteCommitted(nextReceipt(client, HEX64_A, R1)));
    await controller.finalize(makeProof());

    controller.notifyDocumentRevision(HEX64_A);

    expect(controller.state().kind).toBe("committing");
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: true, canRedo: false, stale: 0 });

    controller.notifyDocumentRevision(R1);
    expect(controller.state()).toEqual({ kind: "idle" });
    expect(summary(controller).canUndo).toBe(true); // the coherent read did not invalidate anything
  });

  it("revisions can repeat (an undo returning to an earlier value) without confusing the log", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    await traverse(controller, client, "undo", HEX64_A); // the undo lands back on the revision we started from
    expect(summary(controller)).toEqual({ cursor: 0, entries: 1, canUndo: false, canRedo: true, stale: 0 });

    const { request } = await traverse(controller, client, "redo", R1);

    expect(request.request.baseEditorRevision).toBe(HEX64_A);
    expect(summary(controller)).toEqual({ cursor: 1, entries: 1, canUndo: true, canRedo: false, stale: 0 });
  });

  it("an undo accepted after an external write invalidated the log leaves the cursor where it was but follows the receipt's revision", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    await commitEdit(controller, client, { from: 43, to: 46, base: R1, revision: R2 });
    const prepared = controller.prepareTraversal("undo");
    if (!prepared.ok) throw new Error("expected a traversal");
    client.queueCommitOutcome(definiteCommitted(nextReceipt(client, R2, R3)));
    const sending = controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R2 }));
    // An external write lands while the undo is in flight.
    controller.setGuardInputs(idleGuardInputs({ externalWriteUnsettled: true }));
    await sending;

    expect(controller.history().entries.every((e) => e.stale)).toBe(true);
    expect(controller.history().canUndo).toBe(false);
    expect(controller.history().canRedo).toBe(false);
  });

  // ── prepare / submit traversal (the host's await in between) ─────────────

  it("prepareTraversal refuses with a typed reason and sends nothing", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    expect(controller.prepareTraversal("undo")).toEqual({ ok: false, reason: "nothing-to-undo" });
    expect(controller.prepareTraversal("redo")).toEqual({ ok: false, reason: "nothing-to-redo" });

    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    controller.begin(makeBeginInput({ baseValue: 43 }));
    expect(controller.prepareTraversal("undo")).toEqual({ ok: false, reason: "not-idle" });
    controller.cancel("escape");

    controller.setGuardInputs(idleGuardInputs({ paramsDirty: true }));
    expect(controller.prepareTraversal("undo")).toEqual({ ok: false, reason: "disabled" });
    expect(client.commits).toHaveLength(1);
  });

  it("an entry committed without a known before value is not traversable (refused, never guessed)", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    const receipt = nextReceipt(client, HEX64_A, R1);
    client.queueCommitOutcome(definiteCommitted(receipt));
    // The direct path from idle with no `beforeValue` context.
    await controller.submitVerified({ kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 43 }, makeProof());
    controller.notifyDocumentRevision(R1);

    expect(controller.history().entries).toHaveLength(1);
    expect(controller.prepareTraversal("undo")).toEqual({ ok: false, reason: "not-traversable" });
  });

  it("submitTraversal refuses with target-changed, sending nothing, when the log moved during the host's await", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    await commitEdit(controller, client, { from: 43, to: 46, base: R1, revision: R2 });
    const prepared = controller.prepareTraversal("undo"); // targets op-2
    if (!prepared.ok) throw new Error("expected a traversal");
    const sentBefore = client.commits.length;

    // While the host awaits verify, another gesture on this tab undoes op-2 and the cursor moves.
    await traverse(controller, client, "undo", R3);
    const stale = await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R2 }));

    expect(stale).toEqual({ kind: "refused", reason: "target-changed" });
    expect(client.commits).toHaveLength(sentBefore + 1); // only the traverse() above
    expect(summary(controller)).toEqual({ cursor: 1, entries: 2, canUndo: true, canRedo: true, stale: 0 });
  });

  it("submitTraversal refuses when the proof is for another base revision, and when the log went stale during the await", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    const prepared = controller.prepareTraversal("undo");
    if (!prepared.ok) throw new Error("expected a traversal");

    expect(await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R4 }))).toEqual({ kind: "refused", reason: "target-changed" });

    controller.notifyDocumentRevision(R4); // an external write during the await
    expect(await controller.submitTraversal(prepared, makeProof({ baseEditorRevision: R1 }))).toEqual({ kind: "refused", reason: "target-changed" });
    expect(client.commits).toHaveLength(1);
  });

  it("the prepared request and the stored entry are snapshots: mutating caller-owned objects afterwards changes nothing", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    const before = makeFeature("feature-3", 4);
    const command = { kind: "remove-feature" as const, featureId: "feature-3", bindingVersion: 4 };
    await commitSetup(controller, client, { command, before, base: HEX64_A, revision: R1 });

    before.label = "mutated";
    command.bindingVersion = 99;

    const entry = controller.history().entries[0].entry;
    expect(entry.beforeFeature?.label).toBe("feature-3");
    expect(entry.command).toEqual({ kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.command)).toBe(true);
    expect(Object.isFrozen(entry.beforeFeature)).toBe(true);
    expect(Object.isFrozen(controller.history())).toBe(true);
    const prepared = controller.prepareTraversal("undo");
    expect(prepared.ok && Object.isFrozen(prepared.request)).toBe(true);
  });

  it("history() keeps a stable reference until something changes, and subscribers hear about log-only changes", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    await commitEdit(controller, client, { from: 40, to: 43, base: HEX64_A, revision: R1 });
    const first = controller.history();
    expect(controller.history()).toBe(first);

    const listener = vi.fn();
    controller.subscribe(listener);
    controller.setGuardInputs(idleGuardInputs()); // nothing external: no change
    controller.notifyDocumentRevision(R1); // the revision we already know: no change
    expect(listener).not.toHaveBeenCalled();
    expect(controller.history()).toBe(first);

    controller.notifyDocumentRevision(R4); // an external write: log-only change
    expect(listener).toHaveBeenCalled();
    expect(controller.history()).not.toBe(first);
  });

  // ── criterion 8: double finalize ─────────────────────────────────────────

  it("a second finalize or submitVerified while the first still waits on the port is refused, and the first wait still resolves normally", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "typed");
    const state = controller.state();
    if (state.kind !== "preview-pending") throw new Error("expected preview-pending");
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));

    const first = controller.finalize(makeProof());
    const secondFinalize = await controller.finalize(makeProof({ proofId: "proof-2" }));
    const secondSubmit = await controller.submitVerified({ kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 99 }, makeProof({ proofId: "proof-3" }));

    expect(secondFinalize).toEqual({ kind: "refused", reason: "finalize-pending" });
    expect(secondSubmit).toEqual({ kind: "refused", reason: "finalize-pending" });
    expect(client.commits).toHaveLength(0); // nothing was sent by the refused calls
    expect(controller.state().kind).toBe("preview-pending"); // and nothing changed

    controller.portWriter.write({ value: 43, generation: state.portGeneration });
    const result = await first;

    expect(result.kind).toBe("committed"); // the first promise settles, with its own proof and candidate
    expect(client.commits).toHaveLength(1);
    expect(client.commits[0].request.proofId).toBe("proof-1");
    expect(client.commits[0].request.command).toMatchObject({ kind: "set-value", value: 43 });
  });

  it("the first wait still settles after a refused second call when the transaction is cancelled", async () => {
    const { deps } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "typed");
    const first = controller.finalize(makeProof());
    expect(await controller.finalize(makeProof())).toEqual({ kind: "refused", reason: "finalize-pending" });

    controller.cancel("escape");

    expect(await first).toEqual({ kind: "cancelled" });
  });

  // ── C2 QA gaps (criterion 11) ────────────────────────────────────────────

  it("dispose() settles a pending finalize directly, not only through detach()", async () => {
    const { deps, client } = makeDeps();
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    controller.propose(43, "typed");
    const state = controller.state();
    if (state.kind !== "preview-pending") throw new Error("expected preview-pending");
    const pending = controller.finalize(makeProof());

    controller.dispose();

    expect(await pending).toEqual({ kind: "cancelled" });
    expect(client.commits).toHaveLength(0);
    // A late port write for the abandoned wait must not resurrect anything.
    controller.portWriter.write({ value: 43, generation: state.portGeneration });
    expect(client.commits).toHaveLength(0);
  });

  it("dispose() mid-commit records the pending receipt and a late response never touches the disposed controller's log", async () => {
    const { deps, client } = makeDeps();
    const store = deps.pendingReceipts!;
    const controller = new TransactionController(deps);
    controller.begin(makeBeginInput());
    reachPreviewOk(controller, 43);
    client.queueCommitOutcome(definiteCommitted(makeReceipt()));
    const result = controller.finalize(makeProof());

    controller.dispose();

    expect(await result).toEqual({ kind: "detached", operationId: "op-1" });
    await flushMicrotasks();
    expect(store.has("project-1", "op-1")).toBe(true);
    expect(controller.history().entries).toHaveLength(0);
  });
});
