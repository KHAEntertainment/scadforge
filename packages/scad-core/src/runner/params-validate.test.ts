// @scadforge/scad-core — unit tests for `validateParamValues` (Issue #32).
// No Docker needed: pure function over hand-built `ParamSchema`s.
import { describe, expect, it } from "vitest";
import type { ParamSchema } from "../types.js";
import { validateParamValues } from "./params-validate.js";

const SCHEMA: ParamSchema = {
  title: "bracket",
  parameters: [
    { name: "wall", type: "number", initial: 4, min: 2, max: 10, step: 0.5, group: "Pipe" },
    { name: "label", type: "string", initial: "hi", maxLength: 5, group: "Parameters" },
    { name: "enabled", type: "boolean", initial: true, group: "Parameters" },
    { name: "color", type: "string", initial: "red", group: "Parameters", options: [
      { name: "red", value: "red" },
      { name: "blue", value: "blue" }
    ] },
    { name: "offset", type: "number", initial: [1, 2, 3], group: "Parameters" }
  ]
};

describe("validateParamValues", () => {
  it("accepts an in-range, correctly-typed value", () => {
    const { accepted, rejected } = validateParamValues(SCHEMA, { wall: 6 });
    expect(accepted).toEqual({ wall: 6 });
    expect(rejected).toEqual([]);
  });

  // COUNTEREXAMPLE: unknown param name.
  it("rejects a name the schema does not declare, as unknown_param", () => {
    const { accepted, rejected } = validateParamValues(SCHEMA, { not_a_param: 1 });
    expect(accepted).toEqual({});
    expect(rejected).toEqual([{ name: "not_a_param", reason: "unknown_param", message: expect.any(String) }]);
  });

  // COUNTEREXAMPLE: a param the model no longer declares (stale params.json key / renamed variable)
  // behaves identically to a never-declared name — it is still just "unknown" to the current schema.
  it("rejects a formerly-valid name that the current schema no longer declares", () => {
    const { rejected } = validateParamValues(SCHEMA, { wall_thickness_old: 4 });
    expect(rejected[0]).toMatchObject({ name: "wall_thickness_old", reason: "unknown_param" });
  });

  // COUNTEREXAMPLE: out-of-range numeric value.
  it("rejects a value below min and a value above max, as out_of_range", () => {
    const low = validateParamValues(SCHEMA, { wall: 0 });
    expect(low.rejected[0]).toMatchObject({ name: "wall", reason: "out_of_range" });
    const high = validateParamValues(SCHEMA, { wall: 999 });
    expect(high.rejected[0]).toMatchObject({ name: "wall", reason: "out_of_range" });
  });

  // COUNTEREXAMPLE: wrong type.
  it("rejects a string where a number is expected, as wrong_type", () => {
    const { rejected } = validateParamValues(SCHEMA, { wall: "six" as unknown as number });
    expect(rejected[0]).toMatchObject({ name: "wall", reason: "wrong_type" });
  });

  it("rejects a number where a boolean is expected", () => {
    const { rejected } = validateParamValues(SCHEMA, { enabled: 1 as unknown as boolean });
    expect(rejected[0]).toMatchObject({ name: "enabled", reason: "wrong_type" });
  });

  it("rejects a scalar where the schema's initial shape is a numeric vector", () => {
    const { rejected } = validateParamValues(SCHEMA, { offset: 5 as unknown as number[] });
    expect(rejected[0]).toMatchObject({ name: "offset", reason: "wrong_type" });
  });

  it("accepts a numeric vector matching the initial's vector shape", () => {
    const { accepted, rejected } = validateParamValues(SCHEMA, { offset: [9, 9, 9] });
    expect(accepted).toEqual({ offset: [9, 9, 9] });
    expect(rejected).toEqual([]);
  });

  it("rejects a string longer than maxLength, as out_of_range", () => {
    const { rejected } = validateParamValues(SCHEMA, { label: "too long" });
    expect(rejected[0]).toMatchObject({ name: "label", reason: "out_of_range" });
  });

  it("rejects a value not among a dropdown's declared options", () => {
    const { rejected } = validateParamValues(SCHEMA, { color: "green" });
    expect(rejected[0]).toMatchObject({ name: "color", reason: "out_of_range" });
  });

  it("accepts one of a dropdown's declared options", () => {
    const { accepted } = validateParamValues(SCHEMA, { color: "blue" });
    expect(accepted).toEqual({ color: "blue" });
  });

  // COUNTEREXAMPLE: empty params object -> nothing accepted, nothing rejected, never throws.
  it("an empty values object accepts and rejects nothing", () => {
    expect(validateParamValues(SCHEMA, {})).toEqual({ accepted: {}, rejected: [] });
  });

  // COUNTEREXAMPLE: an empty schema (model not yet parseable) accepts everything unvalidated.
  it("an empty schema accepts every supplied value without validation", () => {
    const emptySchema: ParamSchema = { title: "", parameters: [] };
    const { accepted, rejected } = validateParamValues(emptySchema, { anything: "goes", n: 5 });
    expect(accepted).toEqual({ anything: "goes", n: 5 });
    expect(rejected).toEqual([]);
  });

  it("validates each supplied name independently, mixing accepted and rejected in one call", () => {
    const { accepted, rejected } = validateParamValues(SCHEMA, { wall: 5, bogus: 1, label: "way too long here" });
    expect(accepted).toEqual({ wall: 5 });
    expect(rejected.map((r) => r.name).sort()).toEqual(["bogus", "label"]);
  });
});
