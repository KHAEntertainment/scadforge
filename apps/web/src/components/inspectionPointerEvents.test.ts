import { describe, expect, it, vi } from "vitest";
import { bindInspectionPointerEvents } from "./inspectionPointerEvents.js";

describe("native inspection gesture routing", () => {
  it.each([2, 3, 4, 4.01, 5, 50])("uses the same %spx boundary for hits and empty-space clearing", (delta) => {
    for (const face of [null, 7]) {
      const canvas = document.createElement("canvas");
      const hit = vi.fn();
      const miss = vi.fn();
      const release = bindInspectionPointerEvents(canvas, () => face, hit, miss);
      canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 10, clientY: 10 }));
      canvas.dispatchEvent(new MouseEvent("pointerup", { clientX: 10 + delta, clientY: 10 }));
      canvas.dispatchEvent(new MouseEvent("click", { clientX: 10 + delta, clientY: 10 }));
      expect(hit).toHaveBeenCalledTimes(delta <= 4 && face !== null ? 1 : 0);
      expect(miss).toHaveBeenCalledTimes(delta <= 4 && face === null ? 1 : 0);
      release();
    }
  });

  it("ignores cancelled, right-button, diagonal drag and detached gestures", () => {
    const canvas = document.createElement("canvas");
    const miss = vi.fn();
    const release = bindInspectionPointerEvents(canvas, () => null, vi.fn(), miss);
    canvas.dispatchEvent(new MouseEvent("pointerdown"));
    canvas.dispatchEvent(new Event("pointercancel"));
    canvas.dispatchEvent(new MouseEvent("click"));
    canvas.dispatchEvent(new MouseEvent("pointerdown", { button: 2 }));
    canvas.dispatchEvent(new MouseEvent("click", { button: 2 }));
    canvas.dispatchEvent(new MouseEvent("pointerdown"));
    canvas.dispatchEvent(new MouseEvent("pointerup", { clientX: 3, clientY: 3 }));
    canvas.dispatchEvent(new MouseEvent("click", { clientX: 3, clientY: 3 }));
    release();
    canvas.dispatchEvent(new MouseEvent("pointerdown"));
    canvas.dispatchEvent(new MouseEvent("click"));
    expect(miss).not.toHaveBeenCalled();
  });
});
