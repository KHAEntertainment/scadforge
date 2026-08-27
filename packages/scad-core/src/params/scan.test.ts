// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { scanTopLevel } from "./scan.js";

describe("scanTopLevel — stop/skip semantics (AC 4)", () => {
  it("stops permanently at the first module definition", () => {
    const events = scanTopLevel(`size = 20; // [5:50]\nmodule foo() {\n  x = 1;\n}\nafter = 2; // [0:10]`);
    expect(events.map((e) => e.kind)).toEqual(["decl", "stop"]);
  });

  it("stops permanently at the first module/geometry call", () => {
    const events = scanTopLevel(`size = 20;\ncube([size,size,size]);\nafter = 2;`);
    expect(events.map((e) => e.kind)).toEqual(["decl", "stop"]);
  });

  it("stops at echo()", () => {
    const events = scanTopLevel(`a = 1;\necho("hi");\nb = 2;`);
    expect(events.map((e) => e.kind)).toEqual(["decl", "stop"]);
  });

  it("skips (does not stop at) a non-literal assignment", () => {
    const events = scanTopLevel(`size = 20;\nderived = size * 2;\nafter = 30;`);
    expect(events.map((e) => e.kind)).toEqual(["decl", "skip", "decl"]);
  });

  it("include/use directives are fully transparent", () => {
    const events = scanTopLevel(`include <BOSL2/std.scad>\nsize = 20;\nuse <BOSL2/screws.scad>\ncount = 3;`);
    expect(events.map((e) => e.kind)).toEqual(["decl", "decl"]);
  });

  it("$-prefixed special variables ARE customizable (empirically confirmed)", () => {
    const events = scanTopLevel(`$fn_test = 64; // [8:128]`);
    expect(events).toEqual([
      { kind: "decl", name: "$fn_test", literal: { type: "number", value: 64 }, trailingComment: " [8:128]" }
    ]);
  });
});

describe("scanTopLevel — group headers and captions", () => {
  it("recognizes a block-comment group header alone on its line", () => {
    const events = scanTopLevel(`/* [Pipe] */\nwall = 4;`);
    expect(events[0]).toEqual({ kind: "group", name: "Pipe" });
  });

  it("does not treat a `//[Group]` line comment as a group header (block-comment-only, per contract)", () => {
    const events = scanTopLevel(`// [Group]\nwall = 4;`);
    expect(events[0]).toEqual({ kind: "caption", text: "[Group]" });
  });

  it("a preceding standalone comment line becomes a caption event", () => {
    const events = scanTopLevel(`// Bracket wall thickness\nwall = 4; //[2:0.5:10]`);
    expect(events[0]).toEqual({ kind: "caption", text: "Bracket wall thickness" });
    expect(events[1].kind).toBe("decl");
  });
});

describe("scanTopLevel — never throws (AC 6, malformed/adversarial)", () => {
  const inputs = [
    "",
    "   ",
    "/* unterminated block comment",
    '"unterminated string\ncube(1,2,3);',
    "size = 20; // [10:",
    "size = [1,2,",
    "= 5;",
    "module();();();",
    "{{{{{{",
    "]]]]]][[[[[[",
    "size = 20 // no semicolon at all"
  ];
  for (const input of inputs) {
    it(`does not throw on: ${JSON.stringify(input)}`, () => {
      expect(() => scanTopLevel(input)).not.toThrow();
    });
  }
});
