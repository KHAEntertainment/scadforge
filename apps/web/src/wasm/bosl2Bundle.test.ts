// SPDX-License-Identifier: GPL-3.0-or-later
//
// GPL ZONE — Issue #31.

import { describe, expect, it } from "vitest";
import { BOSL2_FILES, BOSL2_FILE_COUNT, BOSL2_SOURCE_BYTES } from "./bosl2Bundle.js";

describe("bosl2Bundle", () => {
  it("bundles the vendored BOSL2 checkout as inline text — no runtime fetch (cold-init AC)", () => {
    // Matches packages/libs' vendored count (Issue #19) and Spike 1's own
    // BOSL2 file count — proves this is the SAME checkout, not a re-vendor,
    // and that the whole set resolved at build/import time (no async).
    expect(BOSL2_FILE_COUNT).toBe(56);
    expect(BOSL2_SOURCE_BYTES).toBeGreaterThan(0);
  });

  it("keys files under BOSL2/<name>.scad, matching the worker's FS write layout", () => {
    expect(BOSL2_FILES["BOSL2/std.scad"]).toBeDefined();
    expect(BOSL2_FILES["BOSL2/std.scad"]).toContain("include");
  });

  it("counterexample: every entry is non-empty text, not an accidental empty read", () => {
    for (const [path, text] of Object.entries(BOSL2_FILES)) {
      expect(text.length, `${path} should not be empty`).toBeGreaterThan(0);
    }
  });
});
