// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../lib/chatReducer.js";
import { initialChatState } from "../lib/chatReducer.js";
import { ChatPanel } from "./ChatPanel.js";

function baseProps(overrides: Partial<ChatState> = {}) {
  return {
    state: { ...initialChatState, ...overrides },
    isStreaming: false,
    streamError: null,
    onSend: vi.fn(),
    onCheckConnection: vi.fn(),
    onDismissConnection: vi.fn()
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

// ── stream-drop reconciliation (Issue #77) ───────────────────────────────────

describe("ChatPanel — connection lost", () => {
  it("shows the turn id, wires Check result / Dismiss, and blocks Send while unresolved (AC)", () => {
    const props = baseProps({ items: [{ kind: "connection_lost", turnId: "turn-9", status: "lost" }] });
    render(<ChatPanel {...props} />);

    const row = screen.getByTestId("connection-lost");
    expect(row).toHaveTextContent("Connection to the studio server was lost while the turn was running.");
    expect(row).toHaveTextContent("turn-9");

    fireEvent.click(screen.getByRole("button", { name: "Check result" }));
    expect(props.onCheckConnection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismissConnection).toHaveBeenCalledTimes(1);

    // Unresolved connection loss blocks sending, independent of `disabled`/`isStreaming`
    // and independent of the empty-draft rule — non-empty draft still can't submit.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "try again" } });
    expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("shows a checking state and disables the Check result button while a check is in flight", () => {
    const props = baseProps({ items: [{ kind: "connection_lost", turnId: "turn-9", status: "checking" }] });
    render(<ChatPanel {...props} />);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
  });

  it("shows the still-running message and keeps the check retryable", () => {
    const props = baseProps({ items: [{ kind: "connection_lost", turnId: "turn-9", status: "still_running" }] });
    render(<ChatPanel {...props} />);
    expect(screen.getByTestId("connection-lost")).toHaveTextContent("Still running or no changes yet.");
    expect(screen.getByRole("button", { name: "Check result" })).toBeEnabled();
  });

  it("renders the reconciled head once resolved, and re-enables Send", () => {
    const props = baseProps({ items: [{ kind: "reconciled_status", turnId: "turn-9", headId: "0004" }] });
    render(<ChatPanel {...props} />);
    expect(screen.getByTestId("reconciled-status")).toHaveTextContent("Turn finished while disconnected — head is now #0004.");
    // A non-empty draft is what would otherwise disable Send, so this isolates
    // the "unresolved connection loss" block from the separate empty-draft rule.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "continue" } });
    expect(screen.getByRole("button", { name: /Send/ })).toBeEnabled();
  });
});
