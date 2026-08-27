// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseLiteral, parseStringLiteral, parseVectorLiteral, splitTopLevel } from "./literal.js";

describe("parseLiteral", () => {
  it("parses a plain number", () => {
    expect(parseLiteral("20")).toEqual({ type: "number", value: 20 });
  });

  it("parses a negative decimal", () => {
    expect(parseLiteral("-3.5")).toEqual({ type: "number", value: -3.5 });
  });

  it("parses booleans", () => {
    expect(parseLiteral("true")).toEqual({ type: "boolean", value: true });
    expect(parseLiteral("false")).toEqual({ type: "boolean", value: false });
  });

  it("parses a quoted string, including escapes", () => {
    expect(parseLiteral('"hello"')).toEqual({ type: "string", value: "hello" });
    expect(parseLiteral('"a\\"b"')).toEqual({ type: "string", value: 'a"b' });
    expect(parseLiteral('"line\\nbreak"')).toEqual({ type: "string", value: "line\nbreak" });
  });

  it("parses a numeric vector as type number (matches real CLI, not 'vector')", () => {
    expect(parseLiteral("[1,2,3]")).toEqual({ type: "number", value: [1, 2, 3] });
  });

  it("parses a non-numeric vector as our own 'vector' type (documented divergence)", () => {
    expect(parseLiteral("[true,false]")).toEqual({ type: "vector", value: [true, false] });
    expect(parseLiteral('["a","b"]')).toEqual({ type: "vector", value: ["a", "b"] });
  });

  // COUNTEREXAMPLE: not a literal at all -> undefined, never throws.
  it("returns undefined for an expression (not customizable)", () => {
    expect(parseLiteral("size * 2")).toBeUndefined();
    expect(parseLiteral("foo")).toBeUndefined();
    expect(parseLiteral("bar(1,2)")).toBeUndefined();
  });

  // COUNTEREXAMPLE: empty / malformed input never throws.
  it("never throws on empty or malformed input", () => {
    expect(() => parseLiteral("")).not.toThrow();
    expect(parseLiteral("")).toBeUndefined();
    expect(() => parseLiteral("[1,2,")).not.toThrow();
    expect(parseLiteral("[1,2,")).toBeUndefined();
    expect(() => parseLiteral('"unterminated')).not.toThrow();
    expect(parseLiteral('"unterminated')).toBeUndefined();
  });

  it("rejects a vector containing a non-literal element", () => {
    expect(parseVectorLiteral("[1, size, 3]")).toBeUndefined();
  });

  it("rejects an empty vector `[]`", () => {
    expect(parseVectorLiteral("[]")).toBeUndefined();
  });

  it("rejects a vector with a dangling comma", () => {
    expect(parseVectorLiteral("[1,2,]")).toBeUndefined();
  });
});

describe("parseStringLiteral", () => {
  it("rejects unquoted or unbalanced text", () => {
    expect(parseStringLiteral("hello")).toBeUndefined();
    expect(parseStringLiteral('"hello')).toBeUndefined();
    expect(parseStringLiteral('hello"')).toBeUndefined();
  });
});

describe("splitTopLevel", () => {
  it("does not split inside brackets or quotes", () => {
    expect(splitTopLevel("1, [2,3], \"a,b\"")).toEqual(["1", " [2,3]", ' "a,b"']);
  });

  it("handles a single item with no separators", () => {
    expect(splitTopLevel("solo")).toEqual(["solo"]);
  });
});
