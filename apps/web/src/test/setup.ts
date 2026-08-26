import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// `test.globals: false` means testing-library's own auto-cleanup detection
// (which looks for a global `afterEach`) never fires, so each component test
// would otherwise leak its DOM into the next one.
afterEach(() => {
  cleanup();
});

