// SPDX-License-Identifier: Apache-2.0
//
// @docker -- exercises the export orchestration (mesh export + validate_mesh
// gate + refusal/override) against the REAL pinned OpenSCAD image.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerAvailable, fixture } from "../test-support/docker-available.js";
import { exportRun } from "./export.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "scadcore-export-out-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable())("@docker export (real pinned OpenSCAD image)", () => {
  it("exports a valid model to 3mf and passes validation (green gate)", async () => {
    const result = await exportRun({ scadPath: fixture("simple.scad"), outDir, format: "3mf" });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(outDir, "out.3mf"));
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.validation?.ok).toBe(true);
    expect(result.validation?.badge).toBe("green");
    expect(result.validation_overridden).toBe(false);

    const files = await readdir(outDir);
    expect(files).toContain("out.3mf");
    console.log(`[export timing] format=3mf bytes=${result.bytes} export_ms=${result.export_ms.toFixed(1)}`);
  }, 60_000);

  it("exports directly to stl (single invocation path, --export-format=binstl)", async () => {
    const result = await exportRun({ scadPath: fixture("simple.scad"), outDir, format: "stl" });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(outDir, "out.stl"));
    expect(result.validation?.ok).toBe(true);
  }, 60_000);

  it("exports to off", async () => {
    const result = await exportRun({ scadPath: fixture("simple.scad"), outDir, format: "off" });
    expect(result.ok).toBe(true);
    expect(result.validation?.ok).toBe(true);
  }, 60_000);

  it("refuses export on a degenerate-volume mesh (red gate) without an override", async () => {
    const result = await exportRun({ scadPath: fixture("degenerate.scad"), outDir, format: "3mf" });
    expect(result.ok).toBe(false);
    expect(result.path).toBeNull();
    expect(result.error_code).toBe("VALIDATION_FAILED");
    expect(result.validation?.ok).toBe(false);
    expect(result.validation?.failures.map((f) => f.code)).toContain("DEGENERATE_VOLUME");
    expect(result.validation_overridden).toBe(false);

    const files = await readdir(outDir);
    expect(files).not.toContain("out.3mf"); // refused exports never write a file
  }, 60_000);

  it("allows a red-gate export through with allowValidationFailure, and records the override", async () => {
    const result = await exportRun({
      scadPath: fixture("degenerate.scad"),
      outDir,
      format: "3mf",
      allowValidationFailure: true
    });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(outDir, "out.3mf"));
    expect(result.validation?.ok).toBe(false);
    expect(result.validation_overridden).toBe(true);
  }, 60_000);

  it("refuses a multi-component export by default, but allows it via the gate's own allowMultiPart is NOT exposed at export level (only allowValidationFailure) -- override still works", async () => {
    const refused = await exportRun({ scadPath: fixture("two-islands.scad"), outDir, format: "3mf" });
    expect(refused.ok).toBe(false);
    expect(refused.validation?.failures.map((f) => f.code)).toContain("MULTIPLE_COMPONENTS");

    const overridden = await exportRun({
      scadPath: fixture("two-islands.scad"),
      outDir,
      format: "3mf",
      allowValidationFailure: true
    });
    expect(overridden.ok).toBe(true);
    expect(overridden.validation_overridden).toBe(true);
  }, 60_000);

  // COUNTEREXAMPLE: malformed .scad source -> typed error, never an uncaught stack trace.
  it("malformed .scad source -> ok:false with a typed error_code, not a thrown exception", async () => {
    const result = await exportRun({ scadPath: fixture("bad-syntax.scad"), outDir, format: "3mf" });
    expect(result.ok).toBe(false);
    expect(result.path).toBeNull();
    expect(result.error_code).toBeTruthy();
    expect(result.message).toBeTruthy();
  }, 60_000);
});
