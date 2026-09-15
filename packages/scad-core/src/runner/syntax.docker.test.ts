// SPDX-License-Identifier: Apache-2.0
//
// @docker -- runSyntaxCheck against the REAL pinned OpenSCAD image.
import { describe, expect, it } from "vitest";
import { dockerAvailable, fixture } from "../test-support/docker-available.js";
import { runSyntaxCheck } from "./syntax.js";

describe.skipIf(!dockerAvailable())("@docker runSyntaxCheck (real pinned OpenSCAD image)", () => {
  it("a well-formed model passes with no errors", async () => {
    const result = await runSyntaxCheck(fixture("simple.scad"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.ms).toBeGreaterThan(0);
  }, 60_000);

  it("a malformed model fails cleanly with a captured ERROR: line, never an uncaught crash", async () => {
    const result = await runSyntaxCheck(fixture("bad-syntax.scad"));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("ERROR:");
  }, 60_000);

  // COUNTEREXAMPLE: a check exceeding its timeout degrades to a typed failure, never hangs the caller.
  it("exceeding the timeout degrades to ok:false with a typed message, not a hang", async () => {
    const result = await runSyntaxCheck(fixture("simple.scad"), { timeoutMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors[0].toLowerCase()).toContain("timed out");
  }, 30_000);
});
