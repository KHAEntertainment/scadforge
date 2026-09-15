// SPDX-License-Identifier: Apache-2.0

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTransactionController } from "./useTransactionController.js";
import {
  createInMemoryBroadcastChannelFactory,
  createRealTimer,
  createSequentialUuidSource,
  FakeEditorClient
} from "./testDoubles.js";
import type { TransactionControllerDeps } from "./types.js";

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
});
