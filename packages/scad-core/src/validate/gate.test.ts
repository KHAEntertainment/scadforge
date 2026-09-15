// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ValidationReport } from "../types.js";
import { gateValidation } from "./gate.js";

const goodReport: ValidationReport = {
  manifold: true,
  status: "NoError",
  volume_mm3: 8000,
  surface_area: 2400,
  bbox: { min: [0, 0, 0], max: [20, 20, 20] },
  triangle_count: 12,
  components: 1,
  genus: 0
};

describe("gateValidation", () => {
  it("passes a clean manifold mesh with green badge and no warnings", () => {
    const gate = gateValidation(goodReport);
    expect(gate).toEqual({ ok: true, badge: "green", failures: [], warnings: [] });
  });

  it("hard-fails a non-manifold mesh with NOT_MANIFOLD, skipping volume/component checks", () => {
    const notManifold: ValidationReport = {
      manifold: false,
      status: "ConstructionFailed",
      volume_mm3: null,
      surface_area: null,
      bbox: null,
      triangle_count: 10,
      components: null,
      genus: null
    };
    const gate = gateValidation(notManifold);
    expect(gate.ok).toBe(false);
    expect(gate.badge).toBe("red");
    expect(gate.failures).toEqual([{ code: "NOT_MANIFOLD", message: expect.stringContaining("ConstructionFailed") }]);
  });

  it("hard-fails degenerate volume at/below the default threshold (0.001 mm3)", () => {
    const degenerate: ValidationReport = { ...goodReport, volume_mm3: 0.0005 };
    const gate = gateValidation(degenerate);
    expect(gate.ok).toBe(false);
    expect(gate.failures.map((f) => f.code)).toEqual(["DEGENERATE_VOLUME"]);
  });

  it("boundary: volume exactly at the threshold still fails (strictly greater-than required)", () => {
    const boundary: ValidationReport = { ...goodReport, volume_mm3: 0.001 };
    const gate = gateValidation(boundary);
    expect(gate.ok).toBe(false);
    expect(gate.failures.map((f) => f.code)).toEqual(["DEGENERATE_VOLUME"]);
  });

  it("boundary: volume just above the threshold passes", () => {
    const boundary: ValidationReport = { ...goodReport, volume_mm3: 0.0011 };
    expect(gateValidation(boundary).ok).toBe(true);
  });

  it("respects a caller-supplied minVolumeMm3 override", () => {
    const report: ValidationReport = { ...goodReport, volume_mm3: 5 };
    expect(gateValidation(report, { minVolumeMm3: 10 }).ok).toBe(false);
    expect(gateValidation(report, { minVolumeMm3: 1 }).ok).toBe(true);
  });

  it("hard-fails multiple components by default", () => {
    const multi: ValidationReport = { ...goodReport, components: 2, genus: -1 };
    const gate = gateValidation(multi);
    expect(gate.ok).toBe(false);
    expect(gate.failures.map((f) => f.code)).toEqual(["MULTIPLE_COMPONENTS"]);
  });

  it("downgrades multi-component to a warning when allowMultiPart is set, and does not surface genus", () => {
    const multi: ValidationReport = { ...goodReport, components: 2, genus: -1 };
    const gate = gateValidation(multi, { allowMultiPart: true });
    expect(gate.ok).toBe(true);
    expect(gate.badge).toBe("amber");
    expect(gate.warnings).toHaveLength(1);
    expect(gate.warnings[0]).toContain("2 disconnected");
    // genus is only meaningful (and only surfaced) when components === 1.
    expect(gate.warnings.some((w) => w.includes("genus"))).toBe(false);
  });

  it("surfaces nonzero genus as an informational warning only when components === 1", () => {
    const hasHandle: ValidationReport = { ...goodReport, genus: 1 };
    const gate = gateValidation(hasHandle);
    expect(gate.ok).toBe(true);
    expect(gate.badge).toBe("amber");
    expect(gate.warnings).toEqual([expect.stringContaining("genus 1")]);
  });

  it("genus is never a hard gate, however large", () => {
    const bigGenus: ValidationReport = { ...goodReport, genus: 999 };
    expect(gateValidation(bigGenus).ok).toBe(true);
  });

  it("reports every applicable failure together, not just the first", () => {
    const multiFail: ValidationReport = { ...goodReport, volume_mm3: 0, components: 3 };
    const gate = gateValidation(multiFail);
    expect(gate.failures.map((f) => f.code).sort()).toEqual(["DEGENERATE_VOLUME", "MULTIPLE_COMPONENTS"]);
  });
});
