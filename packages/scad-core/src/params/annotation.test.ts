// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parsePrecedingCaption, parseTrailingAnnotation } from "./annotation.js";
import type { ParsedLiteral } from "./literal.js";

const num = (value: number): ParsedLiteral => ({ type: "number", value });
const str = (value: string): ParsedLiteral => ({ type: "string", value });

describe("parseTrailingAnnotation — well-formed forms (AC 1)", () => {
  it("[min:max]", () => {
    expect(parseTrailingAnnotation(" [10:80]", num(32))).toEqual({ min: 10, max: 80, step: 1 });
  });

  it("[min:step:max]", () => {
    expect(parseTrailingAnnotation("[2:0.5:10]", num(4))).toEqual({ min: 2, max: 10, step: 0.5 });
  });

  it("[a, b, c] value list (auto-prepends initial when absent — empirically confirmed CLI quirk)", () => {
    expect(parseTrailingAnnotation("[round, square, hex]", str("round"))).toEqual({
      options: [
        { name: "round", value: "round" },
        { name: "square", value: "square" },
        { name: "hex", value: "hex" }
      ]
    });
    expect(parseTrailingAnnotation("[1,2,3]", num(99))).toEqual({
      options: [
        { name: "99", value: 99 },
        { name: "1", value: 1 },
        { name: "2", value: 2 },
        { name: "3", value: 3 }
      ]
    });
  });

  it("[value:Label, ...] labeled options", () => {
    expect(parseTrailingAnnotation("[red:Red Color, blue:Blue Color, green:Green]", str("red"))).toEqual({
      options: [
        { name: "Red Color", value: "red" },
        { name: "Blue Color", value: "blue" },
        { name: "Green", value: "green" }
      ]
    });
  });

  it("[Label] single bare token -> a length-1 options list (matches real CLI, NOT a caption)", () => {
    expect(parseTrailingAnnotation("[Just a label]", num(7))).toEqual({
      options: [
        { name: "7", value: 7 },
        { name: "Just a label", value: "Just a label" }
      ]
    });
  });

  it("bare integer on a string param -> maxLength", () => {
    expect(parseTrailingAnnotation("20", str("hello"))).toEqual({ maxLength: 20 });
  });

  it("bare integer on a non-string param is treated as a plain caption, not maxLength", () => {
    expect(parseTrailingAnnotation("20", num(3))).toEqual({ caption: "20" });
  });

  it("plain text with no bracket -> caption", () => {
    expect(parseTrailingAnnotation("Facet count for curved surfaces", num(48))).toEqual({
      caption: "Facet count for curved surfaces"
    });
  });

  it("empty trailing comment -> nothing", () => {
    expect(parseTrailingAnnotation("", num(1))).toEqual({});
    expect(parseTrailingAnnotation("   ", num(1))).toEqual({});
  });
});

describe("parseTrailingAnnotation — malformed input never throws (AC 5)", () => {
  it("unclosed bracket -> dropped entirely, not an error", () => {
    expect(() => parseTrailingAnnotation("[1:10", num(5))).not.toThrow();
    expect(parseTrailingAnnotation("[1:10", num(5))).toEqual({});
  });

  it("reversed min > max -> swapped (documented divergence from the CLI's collapse-to-initial quirk)", () => {
    expect(parseTrailingAnnotation("[10:2]", num(5))).toEqual({ min: 2, max: 10, step: 1 });
  });

  it("prose before a bracket (any amount, any spacing) -> entire annotation dropped (empirically confirmed 3x)", () => {
    expect(parseTrailingAnnotation("inline caption text [1:10]", num(5))).toEqual({});
    expect(parseTrailingAnnotation("Caption text[1:10]", num(5))).toEqual({});
  });

  it("empty brackets -> nothing, never throws", () => {
    expect(() => parseTrailingAnnotation("[]", num(5))).not.toThrow();
    expect(parseTrailingAnnotation("[]", num(5))).toEqual({});
    expect(parseTrailingAnnotation("[   ]", num(5))).toEqual({});
  });

  it("non-numeric colon pair on a numeric param -> options (matches real CLI ground truth exactly)", () => {
    expect(() => parseTrailingAnnotation("[a:b]", num(5))).not.toThrow();
    expect(parseTrailingAnnotation("[a:b]", num(5))).toEqual({
      options: [
        { name: "5", value: 5 },
        { name: "b", value: "a" }
      ]
    });
  });
});

describe("parsePrecedingCaption", () => {
  it("is verbatim — brackets are NOT interpreted in this position (empirically confirmed)", () => {
    expect(parsePrecedingCaption(" [Bracketed preceding caption] ")).toBe("[Bracketed preceding caption]");
    expect(parsePrecedingCaption(" Outer diameter of the pipe ")).toBe("Outer diameter of the pipe");
  });
});
