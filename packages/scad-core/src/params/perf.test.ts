// SPDX-License-Identifier: Apache-2.0
//
// @scadforge/scad-core — perf regression tests (Tech Lead / QA finding on
// PR #38): `RANGE_STEP_RE`/`RANGE_RE` (annotation.ts) and `NUMBER_RE`
// (literal.ts) previously used a `\d+\.?\d*` shape that is quadratic-time to
// fail on a long digit run with no disambiguating literal between the `\d+`
// and the trailing `\d*` — a 32k-digit run inside a trailing-comment bracket
// measured ~3.6s, with a projected ~15-30 minutes at 500k digits. Since the
// agent is the one writing `.scad` files, an adversarial or accidentally
// huge numeric literal is reachable input, and a multi-minute hang is worse
// than a thrown error (it never surfaces as a typed error at all).
//
// The fix (see `NUMBER_PART`/`NUMBER_RE`) requires a literal `.` before any
// fractional digits, which removes the split ambiguity and makes matching —
// success or failure — linear in input length. These tests assert that
// linear bound directly, so a future regression back to the ambiguous shape
// is caught here rather than in production.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseTrailingAnnotation } from "./annotation.js";
import { parseLiteral } from "./literal.js";
import { parseParamSchema } from "./parse.js";

/** Fails the test if `fn()` takes longer than `budgetMs`, without ever hanging the suite itself. */
function assertFast(label: string, budgetMs: number, fn: () => void): void {
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms (budget ${budgetMs}ms) — possible ReDoS regression`).toBeLessThan(
    budgetMs
  );
}

describe("ReDoS regression — long digit runs must parse in linear, not quadratic, time", () => {
  it("a 32k-digit run in a trailing-comment bracket (no colon at all) parses in <100ms", () => {
    const digits = "1".repeat(32_000);
    assertFast("annotation.ts: bracket with a bare 32k-digit run", 100, () => {
      const result = parseTrailingAnnotation(`[${digits}]`, { type: "number", value: 1 });
      // Falls through to the options-list path (no colon present) — the
      // point of this test is speed, not the specific shape of the result.
      expect(result).toBeDefined();
    });
  });

  it("a 32k-digit run immediately followed by non-digit garbage (forces the regex to fail) parses in <100ms", () => {
    const digits = "9".repeat(32_000);
    assertFast("annotation.ts: [digits-then-garbage] range attempt", 100, () => {
      parseTrailingAnnotation(`[${digits}x:1]`, { type: "number", value: 1 });
    });
  });

  it("scales linearly, not quadratically: 200k digits stays well under a 2s budget", () => {
    const digits = "3".repeat(200_000);
    assertFast("annotation.ts: 200k-digit bracket", 2_000, () => {
      parseTrailingAnnotation(`[${digits}]`, { type: "number", value: 1 });
    });
  });

  it("literal.ts: a malformed 32k-digit RHS literal (digits + trailing garbage) parses in <100ms", () => {
    const digits = "5".repeat(32_000);
    assertFast("literal.ts: malformed 32k-digit literal", 100, () => {
      parseLiteral(`${digits}x`);
    });
  });

  it("literal.ts: a well-formed 32k-digit RHS number literal parses in <100ms (fast even though it's too large to be a finite JS number)", () => {
    const digits = "7".repeat(32_000);
    assertFast("literal.ts: well-formed 32k-digit literal", 100, () => {
      // 32k digits overflows a JS double to Infinity -- correctly rejected
      // (not finite) by the EXISTING `Number.isFinite` guard, independent of
      // this ReDoS fix. The point here is speed: the regex match itself
      // (success case, no backtracking at all) must stay fast at this size.
      const result = parseLiteral(digits);
      expect(result).toBeUndefined();
    });
  });

  it("literal.ts: a well-formed, in-range 300-digit RHS number literal parses in <100ms and succeeds", () => {
    const digits = "3" + "0".repeat(299); // well within a finite double's range
    assertFast("literal.ts: well-formed 300-digit literal", 100, () => {
      const result = parseLiteral(digits);
      expect(result?.type).toBe("number");
      expect(Number.isFinite(result?.value)).toBe(true);
    });
  });

  it("end-to-end: parseParamSchema on a model containing a 32k-digit adversarial annotation parses in <100ms", () => {
    const digits = "2".repeat(32_000);
    const source = `size = 20; // [${digits}:50]\n`;
    assertFast("parseParamSchema: 32k-digit adversarial annotation", 100, () => {
      const schema = parseParamSchema(source);
      expect(schema.parameters[0].name).toBe("size");
    });
  });
});
