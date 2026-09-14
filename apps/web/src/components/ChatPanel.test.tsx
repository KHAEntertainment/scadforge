import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../lib/chatReducer.js";
import { initialChatState } from "../lib/chatReducer.js";
import { ChatPanel } from "./ChatPanel.js";

function baseProps(overrides: Partial<ChatState> = {}) {
  return {
    state: { ...initialChatState, ...overrides },
    isStreaming: false,
    streamError: null,
    onSend: vi.fn()
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── running-turn feedback (Issue #76) ────────────────────────────────────────

describe("ChatPanel — running-turn placeholder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:05.000Z"));
  });

  it("shows the waiting phase and an elapsed timer that ticks once a second (AC)", () => {
    const props = baseProps({
      items: [{ kind: "turn_running", turnId: "t1", startedAt: "2026-09-13T00:00:00.000Z", phase: "waiting", lastToolName: null }]
    });
    render(<ChatPanel {...props} isStreaming />);

    const row = screen.getByTestId("turn-running");
    expect(row).toHaveTextContent("Waiting for the model");
    expect(row).toHaveTextContent("0:05");

    // Advance one second at a time: the self-rearming timer only schedules
    // its NEXT tick once React has re-rendered from the previous one, so a
    // single 3000ms jump would only fire the first tick within one `act`.
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(screen.getByTestId("turn-running")).toHaveTextContent("0:08");
  });

  it("shows the working phase with the last tool name once tool activity begins (AC)", () => {
    const props = baseProps({
      items: [{ kind: "turn_running", turnId: "t1", startedAt: "2026-09-13T00:00:00.000Z", phase: "working", lastToolName: "render_views" }]
    });
    render(<ChatPanel {...props} isStreaming />);

    expect(screen.getByTestId("turn-running")).toHaveTextContent("Working — render_views");
  });

  it("stops ticking once the turn closes — no leaked interval (AC: fake timers)", () => {
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const running = baseProps({
      items: [{ kind: "turn_running", turnId: "t1", startedAt: "2026-09-13T00:00:00.000Z", phase: "waiting", lastToolName: null }]
    });
    const { rerender } = render(<ChatPanel {...running} isStreaming />);
    expect(screen.getByTestId("turn-running")).toHaveTextContent("0:05");

    // turn_done replaces the running item — the interval-owning effect's
    // dependency (hasRunningTurn) flips false, so its cleanup must fire.
    const closed = baseProps({
      items: [{ kind: "turn_status", turnId: "t1", status: "completed", summary: "Done.", usage: null }]
    });
    rerender(<ChatPanel {...closed} isStreaming={false} />);

    expect(clearSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("turn-running")).not.toBeInTheDocument();

    // Advancing time afterwards must not resurrect the row or throw.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId("turn-running")).not.toBeInTheDocument();
  });

  it("clears its interval on unmount", () => {
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const props = baseProps({
      items: [{ kind: "turn_running", turnId: "t1", startedAt: "2026-09-13T00:00:00.000Z", phase: "waiting", lastToolName: null }]
    });
    const { unmount } = render(<ChatPanel {...props} isStreaming />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it("a new turn's running item re-bases the same ticking display to its own startedAt (no separate per-turn timer to leak)", () => {
    // The ticking effect is keyed on "is any turn running", not on a specific
    // turnId (chatReducer.test.ts covers the item-level "own running item"
    // guarantee) — so back-to-back turns share one clock, and the elapsed
    // reading simply re-bases to whichever running item is on screen.
    const first = baseProps({
      items: [{ kind: "turn_running", turnId: "t1", startedAt: "2026-09-13T00:00:00.000Z", phase: "waiting", lastToolName: null }]
    });
    const { rerender, unmount } = render(<ChatPanel {...first} isStreaming />);
    expect(screen.getByTestId("turn-running")).toHaveTextContent("0:05");

    const second = baseProps({
      items: [
        { kind: "turn_status", turnId: "t1", status: "completed", summary: "Done.", usage: null },
        { kind: "turn_running", turnId: "t2", startedAt: "2026-09-13T00:00:05.000Z", phase: "waiting", lastToolName: null }
      ]
    });
    rerender(<ChatPanel {...second} isStreaming />);
    expect(screen.getByTestId("turn-running")).toHaveTextContent("0:00");
    // Unmount explicitly (under fake timers, deterministically) rather than
    // leaving the still-pending tick for the implicit end-of-test cleanup —
    // this still-pending case is exactly what "clears on unmount" already
    // covers deliberately, so keep it out of automatic teardown here too.
    unmount();
  });
});
