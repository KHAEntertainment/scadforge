import { describe, expect, it } from "vitest";
import { clampMaxPasses, isNonEmptyString, isSafeId, isViewName } from "./validation.js";

describe("isSafeId", () => {
  it("accepts ordinary ids", () => {
    expect(isSafeId("my-bracket")).toBe(true);
    expect(isSafeId("proj_1")).toBe(true);
    expect(isSafeId("my-bracket-0002.3mf")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isSafeId("..")).toBe(false);
    expect(isSafeId("../etc/passwd")).toBe(false);
    expect(isSafeId("foo/../bar")).toBe(false);
    // `%` is outside the allowed character class entirely — a raw percent-
    // encoded segment is rejected even before the `..` check, defense in
    // depth against a router that failed to decode it first.
    expect(isSafeId("..%2Fetc")).toBe(false);
  });

  it("rejects slashes and backslashes outright", () => {
    expect(isSafeId("a/b")).toBe(false);
    expect(isSafeId("a\\b")).toBe(false);
  });

  it("rejects empty, null, undefined, and a bare dot", () => {
    expect(isSafeId("")).toBe(false);
    expect(isSafeId(null)).toBe(false);
    expect(isSafeId(undefined)).toBe(false);
    expect(isSafeId(".")).toBe(false);
  });
});

describe("isViewName", () => {
  it("accepts the five frozen view names and rejects anything else", () => {
    expect(isViewName("iso")).toBe(true);
    expect(isViewName("section")).toBe(true);
    expect(isViewName("bogus")).toBe(false);
    expect(isViewName(undefined)).toBe(false);
  });
});

describe("isNonEmptyString", () => {
  it("rejects whitespace-only strings and non-strings", () => {
    expect(isNonEmptyString("hello")).toBe(true);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
  });
});

describe("clampMaxPasses", () => {
  it("falls back to the default when omitted", () => {
    expect(clampMaxPasses(undefined, 2)).toBe(2);
  });

  it("clamps negative and oversized requests", () => {
    expect(clampMaxPasses(-5, 2)).toBe(0);
    expect(clampMaxPasses(1000, 2)).toBe(10);
  });

  it("floors a fractional request", () => {
    expect(clampMaxPasses(3.7, 2)).toBe(3);
  });
});
