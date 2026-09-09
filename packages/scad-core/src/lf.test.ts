// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { normalizeLineEndings } from "./lf.js";

describe("normalizeLineEndings (#40)", () => {
  it("returns already-LF source unchanged", () => {
    expect(normalizeLineEndings("a\nb\n")).toBe("a\nb\n");
  });

  it("converts CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("converts a lone CR (classic-Mac) to LF", () => {
    expect(normalizeLineEndings("a\rb\r")).toBe("a\nb\n");
  });

  it("is idempotent", () => {
    const once = normalizeLineEndings("a\r\nb\rc\r\n");
    expect(normalizeLineEndings(once)).toBe(once);
    expect(once).toBe("a\nb\nc\n");
  });

  it("does not touch a lone LF", () => {
    expect(normalizeLineEndings("\n")).toBe("\n");
  });
});
