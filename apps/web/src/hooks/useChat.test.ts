// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectManifest, ProjectResponse, SnapshotManifest, SseEvent } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";
import { encodeSseFrame, streamFromEvents } from "../lib/sse.js";
import { useChat } from "./useChat.js";

const PROJECT_ID = "p1";
const TURN_ID = "turn-1";

function turnStarted(): SseEvent {
  return { type: "turn_started", turn_id: TURN_ID, project_id: PROJECT_ID, max_passes: 2, started_at: "2026-09-13T00:00:00.000Z" };
}

function manifest(id: string, overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    id,
    parent: null,
    timestamp: "2026-09-13T00:00:00.000Z",
    message: "snapshot",
    origin: "agent",
    pass: 0,
    files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
    params: {},
    renders: [],
    validation: null,
    annotations: [],
    ...overrides
  };
}

function projectResponse(head: SnapshotManifest | null): ProjectResponse {
  const project: ProjectManifest = {
    schema_version: 1,
    id: PROJECT_ID,
    name: "untitled",
    created: "2026-09-13T00:00:00.000Z",
    updated: "2026-09-13T00:00:00.000Z",
    openscad_image: "openscad@sha256:abc",
    openscad_version: "2026.01.19",
    provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
    head: head?.id ?? null
  };
  return { project, scad: "cube(1);", params: {}, head };
}

/** A stream that ends (no `turn_done`) right after `turn_started` — a graceful mid-turn drop. */
function streamThatEndsAfterTurnStarted(): ReadableStream<Uint8Array> {
  return streamFromEvents([turnStarted()]);
}

/**
 * A stream whose reader rejects mid-turn — the fetch/network-drop path.
 * `pull` (not `start`) so the error only fires once the SECOND read is
 * actually requested — mirroring a real drop that happens after
 * `turn_started` is delivered, not one that discards it before it is ever
 * read.
 */
function streamThatErrorsAfterTurnStarted(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(encodeSseFrame(turnStarted())));
        return;
      }
      controller.error(new Error("network drop"));
    }
  });
}

/**
 * A stream that emits `turn_started` and then never closes on its own —
 * until `signal` aborts, at which point it closes, the way a real fetch
 * response body settles when its request is aborted. Without this coupling
 * an abort would leave the mock stream's reader hung forever, which a real
 * fetch never does.
 */
function neverEndingStreamAbortAware(signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encodeSseFrame(turnStarted())));
      if (!signal) return;
      if (signal.aborted) {
        controller.close();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          try {
            controller.close();
          } catch {
            // Already closed/errored — fine, this is just settling a hang.
          }
        },
        { once: true }
      );
    }
  });
}

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    openChatStream: vi.fn(),
    getProject: vi.fn().mockResolvedValue(projectResponse(null)),
    listSnapshots: vi.fn().mockResolvedValue({ snapshots: [] }),
    ...overrides
  } as unknown as ApiClient;
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("useChat — stream-drop reconciliation (Issue #77)", () => {
  it("shows a connection_lost item, stops streaming, and sets streamError when the stream body ends without turn_done (AC)", async () => {
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() }),
      getProject: vi.fn().mockResolvedValue(projectResponse(manifest("0001")))
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.streamError).toBeTruthy();
    const item = result.current.state.items.find((i) => i.kind === "connection_lost");
    expect(item).toMatchObject({ kind: "connection_lost", turnId: TURN_ID, status: "lost" });
    // No silent reset to idle: the running placeholder is gone, replaced (not duplicated).
    expect(result.current.state.items.filter((i) => i.kind === "turn_running")).toHaveLength(0);
  });

  it("shows a connection_lost item when the fetch itself rejects mid-turn (AC)", async () => {
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatErrorsAfterTurnStarted() })
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    const item = result.current.state.items.find((i) => i.kind === "connection_lost");
    expect(item).toMatchObject({ kind: "connection_lost", turnId: TURN_ID });
    expect(result.current.streamError).toBeTruthy();
  });

  it("counterexample: a turn that closes normally with turn_done never produces a connection_lost item", async () => {
    const events: SseEvent[] = [
      turnStarted(),
      { type: "turn_done", turn_id: TURN_ID, status: "completed", passes_used: 1, summary: "Done.", usage: null, duration_ms: 10 }
    ];
    const client = makeClient({ openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamFromEvents(events) }) });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });

    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(false);
    expect(result.current.streamError).toBeNull();
  });

  it("checkConnectionResult reconciles an advanced head into a reconciled_status item and refreshes headSnapshot (AC)", async () => {
    const advancedHead = manifest("0002");
    const getProject = vi
      .fn()
      .mockResolvedValueOnce(projectResponse(manifest("0001"))) // baseline at turn_started
      .mockResolvedValueOnce(projectResponse(advancedHead)); // the Check-result re-fetch
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() }),
      getProject
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(true);

    await act(async () => {
      await result.current.checkConnectionResult();
    });

    expect(result.current.state.items.find((i) => i.kind === "reconciled_status")).toMatchObject({
      kind: "reconciled_status",
      turnId: TURN_ID,
      headId: "0002"
    });
    expect(result.current.state.headSnapshot).toEqual(advancedHead);
  });

  it("checkConnectionResult with no head advance flips the item to still_running and keeps it retryable (AC)", async () => {
    const sameHead = manifest("0001");
    const getProject = vi.fn().mockResolvedValueOnce(projectResponse(sameHead)).mockResolvedValueOnce(projectResponse(sameHead));
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() }),
      getProject
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    await act(async () => {
      await result.current.checkConnectionResult();
    });

    expect(result.current.state.items.find((i) => i.kind === "connection_lost")).toMatchObject({ status: "still_running" });
  });

  it("counterexample: a rejected baseline fetch is never treated as 'no prior head' — a still-failing retry stays still_running, never falsely advanced (AC)", async () => {
    const getProject = vi
      .fn()
      // The baseline fetch at turn_started fails outright.
      .mockRejectedValueOnce(new Error("network error"))
      // checkConnectionResult's retry of the baseline ALSO fails.
      .mockRejectedValueOnce(new Error("still unreachable"));
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() }),
      getProject
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(true);

    await act(async () => {
      await result.current.checkConnectionResult();
    });

    // An unknown baseline (both fetches failed) must never be compared
    // against a real head as if it meant "no snapshot existed" — that would
    // paint every retry as a false "advanced".
    expect(result.current.state.items.some((i) => i.kind === "reconciled_status")).toBe(false);
    expect(result.current.state.items.find((i) => i.kind === "connection_lost")).toMatchObject({ status: "still_running" });
    expect(getProject).toHaveBeenCalledTimes(2); // the original attempt + the retry, no "current head" fetch without a baseline
  });

  it("a slow baseline fetch from a project the user has switched away from never corrupts the new project's baseline (AC)", async () => {
    let resolveOldBaseline!: (value: ProjectResponse) => void;
    let openChatStreamCalls = 0;
    const openChatStream = vi.fn().mockImplementation((_projectId: string, _turn: unknown, signal?: AbortSignal) => {
      openChatStreamCalls += 1;
      if (openChatStreamCalls === 1) {
        return Promise.resolve({ ok: true, body: neverEndingStreamAbortAware(signal) });
      }
      return Promise.resolve({ ok: true, body: streamThatEndsAfterTurnStarted() });
    });
    const getProject = vi
      .fn()
      // Project A's baseline fetch at turn_started — deliberately slow.
      .mockImplementationOnce(() => new Promise<ProjectResponse>((resolve) => { resolveOldBaseline = resolve; }))
      // Project B's baseline fetch at its own turn_started.
      .mockResolvedValueOnce(projectResponse(manifest("b-0001")))
      // Project B's checkConnectionResult "current head" fetch — unchanged.
      .mockResolvedValueOnce(projectResponse(manifest("b-0001")));
    const client = makeClient({ openChatStream, getProject });

    const { result, rerender } = renderHook(({ projectId }) => useChat(client, projectId), {
      initialProps: { projectId: "project-a" }
    });

    let sendPromiseA!: Promise<void>;
    act(() => {
      sendPromiseA = result.current.sendMessage("build A");
    });
    await waitFor(() => expect(result.current.state.items.some((i) => i.kind === "turn_running")).toBe(true));

    // Switch away from A while its baseline fetch is still pending.
    rerender({ projectId: "project-b" });
    await act(async () => {
      await sendPromiseA;
    });

    // A's slow baseline resolves LATE, after the switch to B.
    resolveOldBaseline(projectResponse(manifest("a-9999")));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.sendMessage("build B");
    });
    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(true);

    await act(async () => {
      await result.current.checkConnectionResult();
    });

    // B's own baseline ("b-0001") is what must be compared — not A's
    // late-arriving "a-9999" — and B's head is unchanged, so the only
    // correct result is "still running", never a false "advanced" from a
    // cross-project-contaminated baseline.
    expect(result.current.state.items.some((i) => i.kind === "reconciled_status")).toBe(false);
    expect(result.current.state.items.find((i) => i.kind === "connection_lost")).toMatchObject({ status: "still_running" });
  });

  it("does not re-check faster than the 5s floor (AC)", async () => {
    const getProject = vi.fn().mockResolvedValue(projectResponse(manifest("0001")));
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() }),
      getProject
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    const callsAfterTurn = getProject.mock.calls.length;

    await act(async () => {
      await result.current.checkConnectionResult();
      await result.current.checkConnectionResult();
    });

    // Only one of the two immediate calls actually re-fetched.
    expect(getProject.mock.calls.length).toBe(callsAfterTurn + 1);
  });

  it("reconciles automatically, once, when the tab regains focus with a lost-connection item present (AC)", async () => {
    const advancedHead = manifest("0002");
    const getProject = vi
      .fn()
      .mockResolvedValueOnce(projectResponse(manifest("0001"))) // baseline at turn_started
      .mockResolvedValueOnce(projectResponse(advancedHead)); // the auto-check on focus
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() }),
      getProject
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(true);
    const callsBeforeFocus = getProject.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(getProject.mock.calls.length).toBe(callsBeforeFocus + 1);
    expect(result.current.state.items.find((i) => i.kind === "reconciled_status")).toMatchObject({ headId: "0002" });

    // A second focus on the same (now-resolved) turn does not check again.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(getProject.mock.calls.length).toBe(callsBeforeFocus + 1);
  });

  it("counterexample: focus with no lost-connection item present triggers no check", async () => {
    const getProject = vi.fn().mockResolvedValue(projectResponse(manifest("0001")));
    const client = makeClient({
      openChatStream: vi.fn().mockResolvedValue({
        ok: true,
        body: streamFromEvents([
          turnStarted(),
          { type: "turn_done", turn_id: TURN_ID, status: "completed", passes_used: 1, summary: "Done.", usage: null, duration_ms: 10 }
        ])
      }),
      getProject
    });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    const callsBeforeFocus = getProject.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(getProject.mock.calls.length).toBe(callsBeforeFocus);
  });

  it("dismissConnectionLost clears the item and re-enables sending", async () => {
    const client = makeClient({ openChatStream: vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() }) });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(true);

    act(() => result.current.dismissConnectionLost());
    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(false);
  });

  it("sendMessage is a defense-in-depth no-op while a connection_lost item is unresolved (AC: blocked until dismissed)", async () => {
    const openChatStream = vi.fn().mockResolvedValue({ ok: true, body: streamThatEndsAfterTurnStarted() });
    const client = makeClient({ openChatStream });
    const { result } = renderHook(() => useChat(client, PROJECT_ID));

    await act(async () => {
      await result.current.sendMessage("Make a box");
    });
    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(true);
    const callsBeforeRetry = openChatStream.mock.calls.length;

    await act(async () => {
      await result.current.sendMessage("try again");
    });
    expect(openChatStream.mock.calls.length).toBe(callsBeforeRetry);

    // Dismissing lifts the block.
    act(() => result.current.dismissConnectionLost());
    openChatStream.mockResolvedValue({
      ok: true,
      body: streamFromEvents([
        turnStarted(),
        { type: "turn_done", turn_id: TURN_ID, status: "completed", passes_used: 1, summary: "Done.", usage: null, duration_ms: 10 }
      ])
    });
    await act(async () => {
      await result.current.sendMessage("try again");
    });
    expect(openChatStream.mock.calls.length).toBe(callsBeforeRetry + 1);
  });

  it("counterexample: switching projects mid-turn aborts cleanly with no connection_lost item (existing abort behavior preserved)", async () => {
    const client = makeClient({
      openChatStream: vi
        .fn()
        .mockImplementation((_projectId: string, _turn: unknown, signal?: AbortSignal) =>
          Promise.resolve({ ok: true, body: neverEndingStreamAbortAware(signal) })
        )
    });
    const { result, rerender } = renderHook(({ projectId }) => useChat(client, projectId), {
      initialProps: { projectId: PROJECT_ID }
    });

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.sendMessage("Make a box");
    });
    await waitFor(() => expect(result.current.state.items.some((i) => i.kind === "turn_running")).toBe(true));

    rerender({ projectId: "p2" });
    await act(async () => {
      await sendPromise;
    });

    expect(result.current.state.items.some((i) => i.kind === "connection_lost")).toBe(false);
    expect(result.current.streamError).toBeNull();
  });
});
