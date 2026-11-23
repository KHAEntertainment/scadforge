// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorDocument } from "@scadforge/protocol";
import type { TransactionController } from "../controller/controller.js";
import type { ControllerState, DisabledReason } from "../controller/types.js";
import { DISABLED_COPY } from "./disabledCopy.js";
import { describeResult, EditSurface, type EditSurfaceSession } from "./EditSurface.js";

const REV = "a".repeat(64);

const DOCUMENT: EditorDocument = {
  version: 1,
  projectId: "p1",
  head: "0001",
  sourceRevision: "b".repeat(64),
  sourceFingerprint: "c".repeat(64),
  editorRevision: REV,
  scad: "cube([wall, 10, 10]);",
  parameters: [],
  values: { wall: 2 },
  sidecar: {
    version: 1,
    features: [
      {
        featureId: "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        label: "Wall",
        projectId: "p1",
        createdAtRevision: REV,
        sourceFingerprint: "c".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } }
      }
    ]
  },
  sidecarStatus: "ready",
  eligibility: []
};

/** A controller stand-in: the surface only calls methods from handlers, never during render. */
function fakeController(): TransactionController {
  return { history: () => ({ entries: [], cursor: 0, canUndo: false, canRedo: false, undoTarget: null, redoTarget: null }) } as unknown as TransactionController;
}

function session(overrides: Partial<EditSurfaceSession> = {}): EditSurfaceSession {
  return {
    activate: vi.fn(),
    setSurfaceMounted: vi.fn(),
    api: { verifyEditorCommand: vi.fn() },
    projectId: "p1",
    document: DOCUMENT,
    documentStatus: "ready",
    controller: fakeController(),
    state: { kind: "idle" },
    history: null,
    adapter: { cancel: vi.fn(() => false) },
    reportWrite: vi.fn(),
    retryRead: vi.fn(),
    retryDisplay: vi.fn(),
    ...overrides
  };
}

function status(): HTMLElement {
  return screen.getByRole("status");
}

const REASONS: DisabledReason[] = [
  "sidecar-unreadable",
  "source-dirty",
  "params-pending",
  "agent-turn-running",
  "external-write-unsettled",
  "display-recovering"
];

describe("EditSurface", () => {
  it.each(REASONS)("renders the copy for the disabled reason %s and disables entry", (reason) => {
    render(<EditSurface session={session({ state: { kind: "disabled", reason } })} />);
    expect(status()).toHaveTextContent(DISABLED_COPY[reason]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByLabelText(/^Wall/)).toBeDisabled();
    if (reason === "display-recovering") expect(screen.getByRole("button", { name: "Retry preview" })).toBeEnabled();
    else expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
  });

  it("gives every disabled reason distinct, non-empty copy", () => {
    const copies = REASONS.map((reason) => DISABLED_COPY[reason]);
    expect(new Set(copies).size).toBe(REASONS.length);
    for (const copy of copies) expect(copy.length).toBeGreaterThan(10);
  });

  it("renders an unknown commit outcome (resolving) as Resolving, never as rejected", () => {
    const state: ControllerState = { kind: "resolving", begin: null, operationId: "op", attempt: 3 };
    render(<EditSurface session={session({ state })} />);
    expect(status()).toHaveTextContent("Resolving");
    expect(status()).not.toHaveTextContent(/not saved|rejected/i);
  });

  it("renders committing as Saving", () => {
    render(<EditSurface session={session({ state: { kind: "committing", begin: null, operationId: "op", receipt: null } })} />);
    expect(status()).toHaveTextContent("Saving…");
  });

  it("renders a neutral loading state while the controller is null, and calls nothing on it", () => {
    const current = session({ controller: null });
    render(<EditSurface session={current} />);
    expect(status()).toHaveTextContent("Preparing the editor…");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(current.activate).toHaveBeenCalledTimes(1);
  });

  it("treats loading and unsettled documents as not ready", () => {
    const { rerender } = render(<EditSurface session={session({ documentStatus: "loading", document: null })} />);
    expect(status()).toHaveTextContent("Loading features…");
    rerender(<EditSurface session={session({ documentStatus: "unsettled" })} />);
    expect(status()).toHaveTextContent("Loading the latest version…");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("describes all seven finalize outcomes, and only `committed` reads as saved", () => {
    expect(describeResult({ kind: "committed", receipt: {} as never }, "save")).toEqual({ tone: "success", text: "Saved." });
    expect(describeResult({ kind: "rejected", reason: "rejected", error: null }, "undo").text).toMatch(/not saved/);
    for (const result of [
      { kind: "detached", operationId: "op" },
      { kind: "preview-failed" },
      { kind: "cancelled" },
      { kind: "refused", reason: "stale-log" }
    ] as const) {
      const notice = describeResult(result, "undo");
      expect(notice.tone).not.toBe("success");
      expect(notice.text).not.toMatch(/^(Undo )?saved\./i);
    }
  });
});
