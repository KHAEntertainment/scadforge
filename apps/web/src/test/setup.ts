import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// React Three Fiber measures its canvas with ResizeObserver. jsdom does not
// provide the browser primitive, so keep the test environment quiet and
// deterministic without changing the production viewer path.
if (typeof globalThis.ResizeObserver === "undefined") {
  class TestResizeObserver implements ResizeObserver {
    observe(): void { /* no layout engine in jsdom */ }
    unobserve(): void { /* no layout engine in jsdom */ }
    disconnect(): void { /* no layout engine in jsdom */ }
  }
  globalThis.ResizeObserver = TestResizeObserver;
}

// `test.globals: false` means testing-library's own auto-cleanup detection
// (which looks for a global `afterEach`) never fires, so each component test
// would otherwise leak its DOM into the next one.
afterEach(() => {
  cleanup();
});
