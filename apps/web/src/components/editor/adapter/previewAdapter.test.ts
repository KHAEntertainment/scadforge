// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { TransactionController } from "../controller/controller.js";
import { createPendingReceiptStore } from "../controller/pendingReceipts.js";
import { createInMemoryBroadcastChannelFactory, createRealTimer, createSequentialUuidSource, FakeEditorClient } from "../controller/testDoubles.js";
import { PreviewAdapter, type EngineSnapshot, type EngineStatus, type WantedRender } from "./previewAdapter.js";

const REV = "a".repeat(64);
const SCAD = "cube([wall, 10, 10]);";

function makeController(): TransactionController {
  return new TransactionController({
    projectId: "p1",
    client: new FakeEditorClient(),
    clock: () => Date.parse("2026-01-01T00:00:00.000Z"),
    timer: createRealTimer(),
    uuid: createSequentialUuidSource(),
    broadcastChannelFactory: createInMemoryBroadcastChannelFactory(),
    onPeerCommitted: () => {},
    pendingReceipts: createPendingReceiptStore()
  });
}

function begin(controller: TransactionController): void {
  const result = controller.begin({
    featureId: "f1",
    bindingVersion: 1,
    baseEditorRevision: REV,
    sourceFingerprint: "b".repeat(64),
    sidecarStatus: "ready",
    eligibility: null,
    freshProof: null,
    baseValue: 2
  });
  if (!result.ok) throw new Error(`begin refused: ${result.reason}`);
}

/** Proposes `value` and returns the want the session would hand the adapter. */
function propose(controller: TransactionController, value: number): WantedRender {
  const result = controller.propose(value, "typed");
  if (!result.ok || "noOp" in result) throw new Error("expected preview-pending");
  const state = controller.state();
  if (state.kind !== "preview-pending") throw new Error(`expected preview-pending, got ${state.kind}`);
  return { scad: SCAD, params: { wall: value }, tag: { projectId: "p1", editorRevision: REV }, sample: { generation: state.portGeneration, value } };
}

/** A fake engine: each event is a fresh object, like `useWasmPreview`'s memoized result. */
function engineEvent(status: EngineStatus, objectUrl: string | null): EngineSnapshot {
  const identity = {};
  return { status, objectUrl, identity };
}

function setup() {
  const controller = makeController();
  const adapter = new PreviewAdapter(() => {});
  adapter.setController(controller);
  return { controller, adapter };
}

describe("PreviewAdapter", () => {
  it("writes the sample only once the geometry of its own request exists, never on status alone (Failure B)", () => {
    const { controller, adapter } = setup();
    adapter.engineUpdate(engineEvent("ok", "blob:base"));
    begin(controller);
    adapter.setWant(propose(controller, 3));
    expect(adapter.engineInput()?.params).toEqual({ wall: 3 });

    // The engine reports `ok` again before the new mesh exists (the old URL).
    adapter.engineUpdate(engineEvent("pending", "blob:base"));
    adapter.engineUpdate(engineEvent("ok", "blob:base"));
    expect(controller.state().kind).toBe("preview-pending");

    adapter.engineUpdate(engineEvent("ok", "blob:wall-3"));
    expect(controller.state().kind).toBe("preview-ok");
    expect(adapter.previewView()).toMatchObject({ status: "ok", shown: { objectUrl: "blob:wall-3" } });
  });

  it("never attributes an older in-flight render to a newer candidate (queue depth one, latest wins)", () => {
    const { controller, adapter } = setup();
    begin(controller);
    adapter.setWant(propose(controller, 3));
    adapter.engineUpdate(engineEvent("pending", null));
    const wantFive = propose(controller, 5);
    adapter.setWant(wantFive);
    // Still rendering 3: the engine is not handed 5 yet.
    expect(adapter.engineInput()?.params).toEqual({ wall: 3 });

    adapter.engineUpdate(engineEvent("ok", "blob:wall-3"));
    expect(controller.state().kind).toBe("preview-pending");
    expect(adapter.engineInput()?.params).toEqual({ wall: 5 });

    adapter.engineUpdate(engineEvent("pending", "blob:wall-3"));
    adapter.engineUpdate(engineEvent("ok", "blob:wall-5"));
    const state = controller.state();
    expect(state.kind).toBe("preview-ok");
    if (state.kind === "preview-ok") expect(state.candidate.value).toBe(5);
  });

  it("fails the port on a NEW engine failure, not on the previous request's leftover error", () => {
    const { controller, adapter } = setup();
    const leftover = engineEvent("error", null);
    adapter.engineUpdate(leftover);
    begin(controller);
    adapter.setWant(propose(controller, 3));
    adapter.engineUpdate(leftover); // same event re-delivered by an unrelated render
    expect(controller.state().kind).toBe("preview-pending");

    adapter.engineUpdate(engineEvent("timeout", null));
    expect(controller.state().kind).toBe("preview-failed");
    expect(adapter.previewView().status).toBe("failed");
  });

  it("answers at once when the engine already rendered exactly these inputs", () => {
    const { controller, adapter } = setup();
    begin(controller);
    adapter.setWant(propose(controller, 3));
    adapter.engineUpdate(engineEvent("ok", "blob:wall-3"));
    controller.cancel("escape");

    begin(controller);
    adapter.setWant(propose(controller, 3));
    expect(controller.state().kind).toBe("preview-ok");
  });

  it("gives a new gesture on inputs whose last render failed a fresh render instead of the cached failure", () => {
    const controller = makeController();
    const restart = vi.fn();
    const adapter = new PreviewAdapter(() => {}, restart);
    adapter.setController(controller);
    begin(controller);
    adapter.setWant(propose(controller, 3));
    adapter.engineUpdate(engineEvent("timeout", null));
    expect(controller.state().kind).toBe("preview-failed");
    controller.cancel("escape");

    begin(controller);
    adapter.setWant(propose(controller, 3));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(controller.state().kind).toBe("preview-pending");
    // The engine comes back with whatever it still held (a baseline, not a result), then renders.
    adapter.engineUpdate(engineEvent("timeout", null));
    expect(controller.state().kind).toBe("preview-pending");
    adapter.engineUpdate(engineEvent("pending", null));
    adapter.engineUpdate(engineEvent("ok", "blob:wall-3"));
    expect(controller.state().kind).toBe("preview-ok");
  });

  it("routes each cancel source at most once per gesture, and never outside a gesture", () => {
    const { controller, adapter } = setup();
    const cancel = vi.spyOn(controller, "cancel");
    expect(adapter.cancel("escape")).toBe(false);

    begin(controller);
    expect(adapter.cancel("pointercancel")).toBe(true);
    expect(adapter.cancel("lostpointercapture")).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("pointercancel");
    expect(controller.state().kind).toBe("idle");

    begin(controller);
    expect(adapter.cancel("window-blur")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("turns pointercancel and lostpointercapture into cancels, but not an intentional release", () => {
    const { controller, adapter } = setup();
    const element = document.createElement("div");
    const cancel = vi.spyOn(controller, "cancel");

    begin(controller);
    adapter.capturePointer(element, 1);
    adapter.releasePointer();
    element.dispatchEvent(new Event("lostpointercapture"));
    expect(cancel).not.toHaveBeenCalled();

    adapter.capturePointer(element, 1);
    element.dispatchEvent(new Event("lostpointercapture"));
    element.dispatchEvent(new Event("pointercancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("lostpointercapture");
    expect(adapter.hasPointerCapture()).toBe(false);
  });

  it("writes nothing for a generation the controller has moved past", () => {
    const { controller, adapter } = setup();
    const write = vi.spyOn(controller.portWriter, "write");
    begin(controller);
    const want = propose(controller, 3);
    adapter.setWant(want);
    controller.cancel("escape");
    adapter.engineUpdate(engineEvent("ok", "blob:wall-3"));
    expect(write).not.toHaveBeenCalled();
  });

  it("never waits for a render it did not request: identical geometry for another project reuses the settled render (F3)", () => {
    const { controller, adapter } = setup();
    const display = (projectId: string): WantedRender => ({ scad: SCAD, params: { wall: 2 }, tag: { projectId, editorRevision: REV }, sample: null });
    adapter.setWant(display("pA"));
    const issued = adapter.engineInput();
    adapter.engineUpdate(engineEvent("pending", null));
    adapter.engineUpdate(engineEvent("ok", "blob:wall-2"));
    expect(adapter.previewView().status).toBe("ok");

    // Same source and params, another project: the engine would see no change and never render.
    adapter.setWant(display("pB"));
    expect(adapter.engineInput()?.scad).toBe(issued?.scad);
    expect(adapter.engineInput()?.paramsKey).toBe(issued?.paramsKey);
    expect(adapter.engineInput()?.tag.projectId).toBe("pB");
    expect(adapter.previewView()).toMatchObject({ status: "ok", tag: { projectId: "pB" }, shown: { objectUrl: "blob:wall-2", tag: { projectId: "pB" } } });

    // The next candidate is not queued behind a phantom render.
    begin(controller);
    const want = { ...propose(controller, 3), tag: { projectId: "pB", editorRevision: REV } };
    adapter.setWant(want);
    expect(adapter.engineInput()?.params).toEqual({ wall: 3 });
    adapter.engineUpdate(engineEvent("pending", "blob:wall-2"));
    adapter.engineUpdate(engineEvent("ok", "blob:wall-3"));
    expect(controller.state().kind).toBe("preview-ok");
  });
});
