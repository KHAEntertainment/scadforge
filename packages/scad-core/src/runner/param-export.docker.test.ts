// @docker -- runParamExport against the REAL pinned OpenSCAD image, and the
// AC "param round-trip" -- output parses into the frozen ParamSchema.
import { describe, expect, it } from "vitest";
import { dockerAvailable, fixture } from "../test-support/docker-available.js";
import { runParamExport } from "./param-export.js";
import type { ParamSchema } from "../types.js";

describe.skipIf(!dockerAvailable())("@docker runParamExport (real pinned OpenSCAD image)", () => {
  it("round-trips the fixture's exposed Customizer parameter into the frozen ParamSchema", async () => {
    const schema: ParamSchema = await runParamExport(fixture("simple.scad"));
    expect(schema.title).toBe("simple");
    const sizeParam = schema.parameters.find((p) => p.name === "size");
    expect(sizeParam).toBeDefined();
    expect(sizeParam?.type).toBe("number");
    expect(sizeParam?.initial).toBe(20);
    expect(sizeParam?.min).toBe(5);
    expect(sizeParam?.max).toBe(50);
  }, 60_000);

  // COUNTEREXAMPLE: malformed source -> typed error, never an uncaught crash/empty success.
  it("malformed .scad source -> typed error, not a silently empty schema", async () => {
    await expect(runParamExport(fixture("bad-syntax.scad"))).rejects.toBeTruthy();
  }, 60_000);
});
