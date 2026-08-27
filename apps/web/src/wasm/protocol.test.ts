import { describe, expect, it } from "vitest";
import { paramValueToScadLiteral, paramsToDefineArgs } from "./protocol.js";

describe("paramValueToScadLiteral", () => {
  it("serializes numbers verbatim", () => {
    expect(paramValueToScadLiteral(42)).toBe("42");
    expect(paramValueToScadLiteral(-3.5)).toBe("-3.5");
    expect(paramValueToScadLiteral(0)).toBe("0");
  });

  it("counterexample: NaN falls back to a valid literal instead of emitting invalid syntax", () => {
    expect(paramValueToScadLiteral(Number.NaN)).toBe("0");
  });

  it("serializes booleans", () => {
    expect(paramValueToScadLiteral(true)).toBe("true");
    expect(paramValueToScadLiteral(false)).toBe("false");
  });

  it("quotes strings", () => {
    expect(paramValueToScadLiteral("hello")).toBe('"hello"');
  });

  it("counterexample: empty string", () => {
    expect(paramValueToScadLiteral("")).toBe('""');
  });

  it("counterexample: string with embedded quotes and backslashes", () => {
    expect(paramValueToScadLiteral('he said "hi"\\now')).toBe('"he said \\"hi\\"\\\\now"');
  });

  it("counterexample: string with a newline", () => {
    expect(paramValueToScadLiteral("line1\nline2")).toBe('"line1\\nline2"');
  });

  it("serializes number arrays as OpenSCAD vectors", () => {
    expect(paramValueToScadLiteral([1, 2, 3])).toBe("[1,2,3]");
  });

  it("counterexample: empty array", () => {
    expect(paramValueToScadLiteral([])).toBe("[]");
  });

  it("serializes string arrays", () => {
    expect(paramValueToScadLiteral(["a", "b"])).toBe('["a","b"]');
  });

  it("serializes boolean arrays", () => {
    expect(paramValueToScadLiteral([true, false])).toBe("[true,false]");
  });
});

describe("paramsToDefineArgs", () => {
  it("produces -D pairs in stable sorted order regardless of insertion order", () => {
    const a = paramsToDefineArgs({ z: 1, a: 2 });
    const b = paramsToDefineArgs({ a: 2, z: 1 });
    expect(a).toEqual(["-D", "a=2", "-D", "z=1"]);
    expect(a).toEqual(b);
  });

  it("counterexample: empty params bag produces no argv entries", () => {
    expect(paramsToDefineArgs({})).toEqual([]);
  });
});
