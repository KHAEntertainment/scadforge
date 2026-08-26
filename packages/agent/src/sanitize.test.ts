// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CODE_BLOCK_PLACEHOLDER,
  containsFencedCodeBlock,
  sanitizeChatText,
  stripFencedCodeBlocks
} from "./sanitize.js";

const FENCE = "```";
const LONG_FENCE = "````";

describe("stripFencedCodeBlocks", () => {
  it("removes a plain fenced block and keeps the prose", () => {
    const text = `Here is the bracket.\n${FENCE}scad\ncube([10,10,10]);\n${FENCE}\nIt is 10mm on a side.`;
    expect(stripFencedCodeBlocks(text)).toBe("Here is the bracket.\n\nIt is 10mm on a side.");
  });

  it("removes an UNTERMINATED fence through the end of the text", () => {
    const text = `Done.\n${FENCE}openscad\nmodule bracket() {\n  cube(10);\n`;
    expect(stripFencedCodeBlocks(text)).toBe("Done.");
  });

  it("removes NESTED fences as one block — an inner ``` does not close a ```` block", () => {
    const text = [
      "Explanation:",
      LONG_FENCE + "markdown",
      FENCE + "scad",
      "cube(10);",
      FENCE,
      LONG_FENCE,
      "Tail."
    ].join("\n");
    const stripped = stripFencedCodeBlocks(text);
    expect(stripped).toBe("Explanation:\n\nTail.");
    expect(stripped).not.toContain("cube");
  });

  it("removes a tilde fence", () => {
    const text = "Before\n~~~\ncylinder(h=5, r=2);\n~~~\nAfter";
    expect(stripFencedCodeBlocks(text)).toBe("Before\n\nAfter");
  });

  it("removes a one-line fenced block", () => {
    expect(stripFencedCodeBlocks(`${FENCE}cube(10);${FENCE}`)).toBe("");
  });

  it("leaves INLINE code spans alone", () => {
    const text = "The `wall` parameter is 2.4mm and `size` is 20mm.";
    expect(stripFencedCodeBlocks(text)).toBe(text);
  });

  it("leaves a mid-sentence backtick run that is not a fence", () => {
    const text = "Use ``wall`` for the thickness.";
    expect(stripFencedCodeBlocks(text)).toBe(text);
  });

  it("removes several blocks in one message", () => {
    const text = `A\n${FENCE}\nx\n${FENCE}\nB\n${FENCE}\ny\n${FENCE}\nC`;
    expect(stripFencedCodeBlocks(text)).toBe("A\n\nB\n\nC");
  });

  it("substitutes a placeholder when one is supplied", () => {
    const text = `Summary.\n${FENCE}scad\ncube(10);\n${FENCE}`;
    expect(stripFencedCodeBlocks(text, { placeholder: CODE_BLOCK_PLACEHOLDER })).toBe(
      `Summary.\n${CODE_BLOCK_PLACEHOLDER}`
    );
  });

  it("handles an empty or whitespace-only message", () => {
    expect(stripFencedCodeBlocks("")).toBe("");
    expect(stripFencedCodeBlocks("   \n\n  ")).toBe("");
  });

  it("strips a whole-file paste, which is the failure Spike 3 actually observed", () => {
    const scad = [
      "/* [Main] */",
      "wall = 2.4; // [1:0.2:6]",
      "$fn = 48;",
      "module bracket() { cube([20,20,wall]); }",
      "bracket();"
    ].join("\n");
    const text = `I could not fix it, so here is the file:\n${FENCE}scad\n${scad}\n${FENCE}`;
    const stripped = stripFencedCodeBlocks(text);
    expect(stripped).toBe("I could not fix it, so here is the file:");
    expect(stripped).not.toMatch(/module|cube|\$fn/);
  });
});

describe("containsFencedCodeBlock", () => {
  it("detects a fenced block", () => {
    expect(containsFencedCodeBlock(`a\n${FENCE}\nb\n${FENCE}`)).toBe(true);
  });
  it("detects an unterminated fence", () => {
    expect(containsFencedCodeBlock(`a\n${FENCE}scad\nb`)).toBe(true);
  });
  it("does not fire on prose", () => {
    expect(containsFencedCodeBlock("Just `wall` and prose.")).toBe(false);
  });
});

describe("sanitizeChatText", () => {
  it("clamps to maxLength with an ellipsis", () => {
    const result = sanitizeChatText("abcdefghij", 5);
    expect(result).toHaveLength(5);
    expect(result.endsWith("…")).toBe(true);
  });

  it("does not clamp a short message", () => {
    expect(sanitizeChatText("short", 200)).toBe("short");
  });

  it("strips before clamping", () => {
    expect(sanitizeChatText(`ok\n${FENCE}\ncube(10);\n${FENCE}`, 200)).toBe("ok");
  });
});
