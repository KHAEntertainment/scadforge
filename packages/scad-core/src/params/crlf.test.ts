// SPDX-License-Identifier: Apache-2.0
//
// Tech Lead / QA finding on PR #38: the real pinned OpenSCAD CLI's Customizer
// comment parsing is unreliable on CRLF-terminated `.scad` source (confirmed
// empirically — see `crlf.ts`'s doc comment for the three probes and why the
// exact trigger isn't a simple per-line rule). These tests pin our chosen
// SAFE response: conservative, file-wide annotation stripping whenever a
// CRLF line ending is present anywhere, so the parser never claims more
// interactivity than the renderer will actually honor.

import { describe, expect, it } from "vitest";
import { CRLF_ANNOTATION_WARNING, sourceHasCrlf } from "./crlf.js";
import { parseParamSchema, parseParamSchemaWithDiagnostics } from "./parse.js";

const CRLF_SOURCE =
  '/* [Pipe] */\r\n// Outer diameter of the pipe\r\npipe_d = 32; // [10:80]\r\nEnabled = true;\r\n';

describe("sourceHasCrlf", () => {
  it("detects CRLF", () => {
    expect(sourceHasCrlf("a = 1;\r\nb = 2;\r\n")).toBe(true);
  });
  it("is false for plain LF source", () => {
    expect(sourceHasCrlf("a = 1;\nb = 2;\n")).toBe(false);
  });
  it("is false for a lone CR with no following LF", () => {
    expect(sourceHasCrlf("a = 1;\rb = 2;\r")).toBe(false);
  });
  it("detects a single CRLF even in an otherwise-LF file (mixed endings)", () => {
    expect(sourceHasCrlf("a = 1;\nb = 2;\r\nc = 3;\n")).toBe(true);
  });
});

describe("parseParamSchema — CRLF conservatively strips annotation-derived fields file-wide", () => {
  it("keeps name/type/initial/group, drops caption/min/max/step for every parameter", () => {
    const schema = parseParamSchema(CRLF_SOURCE, { title: "crlf-fixture" });
    expect(schema.parameters).toEqual([
      { name: "pipe_d", type: "number", initial: 32, group: "Pipe" },
      { name: "Enabled", type: "boolean", initial: true, group: "Pipe" }
    ]);
    // None of the stripped fields leak through, even as `undefined` keys.
    for (const p of schema.parameters) {
      expect(p).not.toHaveProperty("caption");
      expect(p).not.toHaveProperty("min");
      expect(p).not.toHaveProperty("max");
      expect(p).not.toHaveProperty("step");
      expect(p).not.toHaveProperty("maxLength");
      expect(p).not.toHaveProperty("options");
    }
  });

  it("group headers still work correctly under CRLF (confirmed against the real CLI)", () => {
    const schema = parseParamSchema('/* [Sect A] */\r\na1 = 1;\r\n/* [Sect B] */\r\nb1 = 2;\r\n');
    expect(schema.parameters.map((p) => p.group)).toEqual(["Sect A", "Sect B"]);
  });

  it("is file-wide, not just for the specific CRLF-terminated line: an LF-only param in an otherwise-CRLF file is still stripped", () => {
    // Deliberately conservative (see crlf.ts): even though a mixed-endings
    // probe against the real CLI showed an LF line's OWN annotation survives
    // independent of a neighboring CRLF line, we strip file-wide rather than
    // per-line, because the real CLI's CRLF handling was also shown to be
    // inconsistent in a way that isn't reliably predictable from the
    // surrounding content alone (same annotation, same line ending, two
    // different real-CLI outcomes depending on unrelated preceding text).
    const mixed = "pipe_d = 32; // [10:80]\nwall = 4; //[2:0.5:10]\r\n";
    const schema = parseParamSchema(mixed);
    expect(schema.parameters.every((p) => p.min === undefined)).toBe(true);
  });

  it("plain LF source is completely unaffected", () => {
    const schema = parseParamSchema("pipe_d = 32; // [10:80]\n");
    expect(schema.parameters[0].min).toBe(10);
    expect(schema.parameters[0].max).toBe(80);
  });

  it("never throws on CRLF mixed with otherwise-malformed annotations", () => {
    expect(() => parseParamSchema("size = 20; // [10:\r\nother = 5; //[a:b]\r\n")).not.toThrow();
  });
});

describe("parseParamSchemaWithDiagnostics", () => {
  it("surfaces the CRLF warning exactly once, and the identical (stripped) schema parseParamSchema would return", () => {
    const { schema, warnings } = parseParamSchemaWithDiagnostics(CRLF_SOURCE, { title: "crlf-fixture" });
    expect(warnings).toEqual([CRLF_ANNOTATION_WARNING]);
    expect(schema).toEqual(parseParamSchema(CRLF_SOURCE, { title: "crlf-fixture" }));
  });

  it("returns no warnings for plain LF source", () => {
    const { warnings } = parseParamSchemaWithDiagnostics("size = 20; // [5:50]\n");
    expect(warnings).toEqual([]);
  });
});
