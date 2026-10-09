// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTransactionController } from "./useTransactionController.js";
import {
  createInMemoryBroadcastChannelFactory,
  createRealTimer,
  createSequentialUuidSource,
  FakeEditorClient
} from "./testDoubles.js";
import type { BeginInput, TransactionControllerDeps } from "./types.js";

function makeDeps(projectId: string): TransactionControllerDeps {
  return {
    projectId,
    client: new FakeEditorClient(),
    clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
    timer: createRealTimer(),
    uuid: createSequentialUuidSource(),
    broadcastChannelFactory: createInMemoryBroadcastChannelFactory(),
    onPeerCommitted: vi.fn()
  };
}

function makeBeginInput(): BeginInput {
  return {
    featureId: "feature-1",
    bindingVersion: 1,
    baseEditorRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    sidecarStatus: "ready",
    eligibility: null,
    freshProof: null,
    baseValue: 40
  };
}

function Probe({ deps }: { deps: TransactionControllerDeps }) {
  const { state } = useTransactionController(deps);
  return <div data-testid="state">{state.kind}</div>;
}

describe("useTransactionController", () => {
  it("renders the controller's current state and re-renders on transitions", () => {
    const deps = makeDeps("project-1");
    render(<Probe deps={deps} />);

    expect(screen.getByTestId("state").textContent).toBe("idle");
  });

  it("re-renders when the controller transitions (useSyncExternalStore binding)", () => {
    const deps = makeDeps("project-1");
    let capturedController: ReturnType<typeof useTransactionController>["controller"] | null = null;

    function Capture() {
      const { state, controller } = useTransactionController(deps);
      capturedController = controller;
      return <div data-testid="state">{state.kind}</div>;
    }

    render(<Capture />);
    expect(screen.getByTestId("state").textContent).toBe("idle");

    act(() => {
      capturedController?.setGuardInputs({
        sidecarStatus: "corrupt",
        sourceDirty: false,
        sourceConflict: false,
        paramsDirty: false,
        paramsSaving: false,
        agentTurnRunning: false,
        externalWriteUnsettled: false
      });
    });

    expect(screen.getByTestId("state").textContent).toBe("disabled");
  });

  it("disposes the controller on unmount", () => {
    const deps = makeDeps("project-1");
    let capturedController: ReturnType<typeof useTransactionController>["controller"] | null = null;

    function Capture() {
      const { controller } = useTransactionController(deps);
      capturedController = controller;
      return null;
    }

    const { unmount } = render(<Capture />);
    const disposeSpy = vi.spyOn(capturedController!, "dispose");

    unmount();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  describe("StrictMode survival (GLM B1)", () => {
    it("begin() succeeds and the second-tab channel is open after mount under StrictMode", () => {
      const factory = createInMemoryBroadcastChannelFactory();
      const onPeerCommitted = vi.fn();
      const deps = makeDeps("project-1");
      deps.broadcastChannelFactory = factory;
      deps.onPeerCommitted = onPeerCommitted;

      const { result } = renderHook(() => useTransactionController(deps), { wrapper: StrictMode });

      // StrictMode's dev-mode double-invoke (setup -> cleanup -> setup) must
      // leave a LIVE controller once mount settles, not a disposed one — a
      // useMemo-built controller disposed only by the practice cleanup would
      // make this refuse with "not-idle" forever.
      expect(result.current.controller).not.toBeNull();
      const beginResult = result.current.controller!.begin(makeBeginInput());
      expect(beginResult).toEqual({ ok: true });

      // The second-tab BroadcastChannel is genuinely open on the survivor —
      // not on the disposed practice instance, whose channel was closed.
      const peer = factory("scadforge-editor-project-1");
      act(() => {
        peer.postMessage({ type: "committed", operationId: "op-x" });
      });
      expect(onPeerCommitted).toHaveBeenCalledTimes(1);
    });

    it("a projectId change disposes the old controller exactly once", () => {
      const { result, rerender } = renderHook((deps: TransactionControllerDeps) => useTransactionController(deps), {
        wrapper: StrictMode,
        initialProps: makeDeps("project-1")
      });
      const oldController = result.current.controller!;
      const disposeSpy = vi.spyOn(oldController, "dispose");

      rerender(makeDeps("project-2"));

      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(result.current.controller).not.toBeNull();
      expect(result.current.controller).not.toBe(oldController);
    });
  });
});
