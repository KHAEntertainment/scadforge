// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ParamSchema } from "../types.js";
import { analyzeSourceParams } from "./source-params.js";

describe("analyzeSourceParams (#54)", () => {
  const schema: ParamSchema = {
    title: "m",
    parameters: [
      { name: "size", type: "number", initial: 20, min: 5, max: 50 },
      { name: "label", type: "string", initial: "hi", options: [{ name: "hi", value: "hi" }] }
    ]
  };

  it("retains compatible overrides unchanged", () => {
    const r = analyzeSourceParams(schema, { size: 30, label: "hi" }, true);
    expect(r.retained_params).toEqual({ size: 30, label: "hi" });
    expect(r.removed_params).toEqual([]);
  });

  it("drops an override whose name is no longer declared", () => {
    const r = analyzeSourceParams(schema, { size: 30, gone: 1 }, true);
    expect(r.retained_params).toEqual({ size: 30 });
    expect(r.removed_params).toEqual([{ name: "gone", reason: expect.stringContaining("not a declared") }]);
  });

  it("drops an override that is now out of range", () => {
    const r = analyzeSourceParams(schema, { size: 999 }, true);
    expect(r.removed_params).toEqual([{ name: "size", reason: expect.stringContaining("max") }]);
    expect(r.retained_params).toEqual({});
  });

  it("drops an override that is now the wrong type", () => {
    const r = analyzeSourceParams(schema, { label: 5 as unknown as string }, true);
    expect(r.removed_params).toEqual([{ name: "label", reason: expect.stringContaining("string") }]);
  });

  it("drops an override that is no longer an allowed option", () => {
    const r = analyzeSourceParams(schema, { label: "other" }, true);
    expect(r.removed_params).toEqual([{ name: "label", reason: expect.stringContaining("options") }]);
  });

  it("drops every override when the source declares no parameters", () => {
    const r = analyzeSourceParams({ title: "m", parameters: [] }, { size: 30 }, true);
    expect(r.removed_params).toEqual([{ name: "size", reason: expect.stringContaining("no longer declared") }]);
    expect(r.retained_params).toEqual({});
  });

  it("returns an empty analysis when the source does not parse", () => {
    expect(analyzeSourceParams(schema, { size: 30 }, false)).toEqual({ retained_params: {}, removed_params: [] });
  });
});
