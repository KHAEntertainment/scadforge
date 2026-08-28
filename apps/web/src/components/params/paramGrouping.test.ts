import { describe, expect, it } from "vitest";
import type { ParamDefinitionWire } from "@scadforge/protocol";
import { groupParams } from "./paramGrouping.js";

function def(overrides: Partial<ParamDefinitionWire> & Pick<ParamDefinitionWire, "name">): ParamDefinitionWire {
  return { type: "number", initial: 0, ...overrides };
}

describe("groupParams", () => {
  it("counterexample: empty schema reduces to an empty list", () => {
    expect(groupParams([])).toEqual([]);
  });

  it("puts ungrouped parameters (no `group`) into one null-named bucket", () => {
    const result = groupParams([def({ name: "a" }), def({ name: "b" })]);
    expect(result).toEqual([{ name: null, parameters: [def({ name: "a" }), def({ name: "b" })] }]);
  });

  it("groups by `/* [Section] */` heading, preserving first-seen group order and in-group order", () => {
    const params = [
      def({ name: "wall", group: "Pipe" }),
      def({ name: "length", group: "Pipe" }),
      def({ name: "count", group: "Array" }),
      def({ name: "spacing", group: "Array" })
    ];
    const result = groupParams(params);
    expect(result.map((g) => g.name)).toEqual(["Pipe", "Array"]);
    expect(result[0].parameters.map((p) => p.name)).toEqual(["wall", "length"]);
    expect(result[1].parameters.map((p) => p.name)).toEqual(["count", "spacing"]);
  });

  it("interleaves grouped and ungrouped parameters in schema order, including a group revisited later", () => {
    const params = [
      def({ name: "a" }), // ungrouped
      def({ name: "wall", group: "Pipe" }),
      def({ name: "b" }), // ungrouped (same bucket as `a`)
      def({ name: "length", group: "Pipe" }) // revisits the Pipe bucket, does not create a new one
    ];
    const result = groupParams(params);
    // First-seen order: ungrouped bucket appears first (from `a`), then Pipe (from `wall`).
    expect(result.map((g) => g.name)).toEqual([null, "Pipe"]);
    expect(result[0].parameters.map((p) => p.name)).toEqual(["a", "b"]);
    expect(result[1].parameters.map((p) => p.name)).toEqual(["wall", "length"]);
  });
});
