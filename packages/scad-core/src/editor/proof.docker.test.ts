// @scadforge/scad-core — @docker proof.ts tests against the real repository
// clamp and hinge fixtures (Issue #91, S3-B ticket B5). Renders through the
// pinned OpenSCAD image for real; no mocked geometry here (see proof.test.ts
// for the mocked-geometry unit tests).
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EditorFeature } from "@scadforge/protocol";
import { runParamExport } from "../runner/param-export.js";
import { dockerAvailable } from "../test-support/docker-available.js";
import { PROOF_THRESHOLDS } from "../geometry/thresholds.js";
import type { ProofRecord } from "./proof.js";
import { runProbe, type RunProbeInput } from "./proof.js";

/**
 * Review Q2 calibration evidence: the real cross-sample axial-center drift
 * of a matched radial region's representative center, on an actual render
 * -- not the 0.05mm safety margin `PROOF_THRESHOLDS.radialIdentityAxialToleranceMm`
 * enforces, but what a genuinely unchanged physical feature's axial
 * position actually measures as, run to run. `axisIndex` is 0/1/2 for the
 * declared binding's x/y/z axis (the index into `ProofSample["geometry"]`'s
 * `centerMm` tuple).
 */
function maxAxialDrift(record: ProofRecord, axisIndex: 0 | 1 | 2): number {
  const axialValues = record.samples.map((sample) => {
    if (sample.geometry.kind !== "radial" || sample.geometry.centerMm === null) {
      throw new Error("maxAxialDrift: expected every sample to be a matched radial sample");
    }
    return sample.geometry.centerMm[axisIndex];
  });
  return Math.max(...axialValues) - Math.min(...axialValues);
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLAMP_SCAD = `${REPO_ROOT}evals/scenario-a2/fixture/clamp.scad`;
const HINGE_SCAD = `${REPO_ROOT}evals/surface-inspection/fixture/hinge.scad`;
const RADIUS_BOSS_SCAD = fileURLToPath(new URL("./__fixtures__/radius-boss.scad", import.meta.url));
const SEGMENTED_BORES_SCAD = fileURLToPath(new URL("./__fixtures__/segmented-bores.scad", import.meta.url));

const PROJECT_ID = "clamp-hinge-fixture"; // real project ids are slugs, never UUIDs

function baseRequest(overrides: Partial<RunProbeInput>): RunProbeInput {
  return {
    projectId: PROJECT_ID,
    baseEditorRevision: "a".repeat(64),
    intent: "edit",
    traversal: null,
    features: [],
    scad: "",
    authoritativeParams: {},
    schema: { title: "", parameters: [] },
    command: { kind: "set-value", featureId: "unused", bindingVersion: 1, value: 0 },
    ...overrides
  };
}

describe.skipIf(!dockerAvailable())("@docker proof.ts against the repository clamp and hinge fixtures", () => {
  describe("clamp: linear wall binding (scale-2, centered)", () => {
    it("proves a valid scale-2 centered clamp wall change", async () => {
      const scad = await readFile(CLAMP_SCAD, "utf8");
      const schema = await runParamExport(CLAMP_SCAD);
      // Fixture defaults (clamp.scad): pipe_dia=32, wall=3, width=20, plate=4,
      // screw_dia=4.5. The X extent of the fused clamp+backplate solid is
      // `2*(pipe_dia/2+wall) + plate - 1` (outer cylinder radius on one side,
      // backplate's overlap-preserving translate on the other) -- scale 2 in
      // `wall`, offset `pipe_dia + plate - 1`, anchor "center" (the backplate
      // translate exactly cancels wall's contribution to the X center).
      const authoritativeParams = { pipe_dia: 32, wall: 3, width: 20, plate: 4, screw_dia: 4.5 };
      const feature: EditorFeature = {
        featureId: "wall-feature",
        label: "Clamp wall",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 2, offset: 32 + 4 - 1, anchor: "center" } }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "wall-feature", bindingVersion: 1, value: 5 }
        })
      );

      expect(result.status).toBe("proved");
      if (result.status === "proved") {
        expect(result.record.samples.length).toBe(3);
        for (const sample of result.record.samples) {
          expect(sample.geometry.kind).toBe("linear");
        }
      }
    }, 60_000);

    it("refuses a deliberately wrong offset", async () => {
      const scad = await readFile(CLAMP_SCAD, "utf8");
      const schema = await runParamExport(CLAMP_SCAD);
      const authoritativeParams = { pipe_dia: 32, wall: 3, width: 20, plate: 4, screw_dia: 4.5 };
      const feature: EditorFeature = {
        featureId: "wall-feature",
        label: "Clamp wall",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 2, offset: 0, anchor: "center" } } // wrong: should be pipe_dia+plate-1 = 35
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "wall-feature", bindingVersion: 1, value: 5 }
        })
      );

      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toMatch(/does not track/);
      }
    }, 60_000);
  });

  describe("hinge: radial bore binding — real-engine REFUSAL (coupled-position bore)", () => {
    // AC substitution (Issue #91's "radius and diameter proofs on the
    // hinge bore", recorded in the PR body): hinge.scad's
    // knuckle_y = pin_d/2 + knuckle_wall - 1 (the "1mm overlap" trick), so
    // the bore's own RADIAL POSITION, not just its diameter, moves with
    // pin_d. Verified directly: at baseline pin_d=4.5 the declared center
    // matches all three knuckle bores; at pin_d=5.0 (one legal Customizer
    // step away) the true bore center has already moved 0.25mm — 25x the
    // S2 0.01mm position tolerance. No sample selection fixes this; a
    // radial binding's center is one fixed point by contract, and this
    // fixture's knuckle geometry cannot be described by one. REFUSING is
    // the correct, honest proof result here — an edit through this binding
    // would move geometry the binding claims is fixed. This is NOT the
    // hinge's own S2-3 recognition fixture data (evals/surface-inspection);
    // it is this ticket's own binding declared against that model, and it
    // legitimately refuses. The "regions: 3" segmented-feature PASS this
    // AC line was after is instead proven for real by segmented-bores.scad
    // below, whose bore position does NOT depend on its diameter
    // parameter, and by the clamp's pipe bore.
    it("refuses a diameter-meaning proof on the knuckle bores: the bore moves with pin_d", async () => {
      const scad = await readFile(HINGE_SCAD, "utf8");
      const schema = await runParamExport(HINGE_SCAD);
      const pinD = 4.5;
      const knuckleWall = 2;
      const knuckleR = pinD / 2 + knuckleWall;
      const authoritativeParams = { pin_d: pinD, knuckle_wall: knuckleWall, $fn: 48 };
      const feature: EditorFeature = {
        featureId: "bore-feature",
        label: "Knuckle bore",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "radial", parameter: "pin_d", center: [0, knuckleR - 1, 4], axis: [1, 0, 0], parameterMeaning: "diameter", presentation: "diameter" }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "bore-feature", bindingVersion: 1, value: 5.5 }
        })
      );

      // Baseline (pin_d=4.5) matches all three knuckle bores; the candidate
      // (5.5) or perturbation moves the true bore position past the S2
      // tolerance, so this hits the specific "moves or changes shape"
      // message, not the generic "no candidate at all" one.
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toMatch(/moves or changes shape/);
      }
    }, 60_000);

    // pin_d also controls the hinge's rendered DIAMETER directly
    // (`cylinder(d = pin_d, ...)`); declaring parameterMeaning "radius"
    // against it claims an expected diameter of 2*pin_d, which never
    // renders even at the BASELINE sample -- the generic empty-set message
    // applies here, not the "moves" one (see the mismatch is present from
    // the first sample, unlike the diameter case above).
    it("refuses a radius-meaning interpretation of the same (actually-diameter) pin_d parameter", async () => {
      const scad = await readFile(HINGE_SCAD, "utf8");
      const schema = await runParamExport(HINGE_SCAD);
      const pinD = 4.5;
      const knuckleWall = 2;
      const knuckleR = pinD / 2 + knuckleWall;
      const authoritativeParams = { pin_d: pinD, knuckle_wall: knuckleWall, $fn: 48 };
      const feature: EditorFeature = {
        featureId: "bore-feature",
        label: "Knuckle bore (mislabeled as radius)",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "radial", parameter: "pin_d", center: [0, knuckleR - 1, 4], axis: [1, 0, 0], parameterMeaning: "radius", presentation: "radius" }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "bore-feature", bindingVersion: 1, value: 5.5 }
        })
      );

      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toMatch(/no circular region matched/);
      }
    }, 60_000);
  });

  describe("segmented-bores (test-only fixture): collinear same-diameter segments, one feature", () => {
    // Real-engine replacement for the hinge's regions:3 AC line (see the
    // hinge describe block above for why the hinge itself cannot pass):
    // three coaxial tube segments at FIXED X positions, only their shared
    // bore diameter depends on the Customizer parameter -- a diameter-
    // meaning radial binding genuinely passes with regions: 3 at every
    // sample.
    it("proves a diameter-meaning proof across three collinear segments (regions: 3)", async () => {
      const scad = await readFile(SEGMENTED_BORES_SCAD, "utf8");
      const schema = await runParamExport(SEGMENTED_BORES_SCAD);
      const authoritativeParams = { bore_d: 4 };
      const feature: EditorFeature = {
        featureId: "bore-feature",
        label: "Segmented bore",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "radial", parameter: "bore_d", center: [0, 0, 0], axis: [1, 0, 0], parameterMeaning: "diameter", presentation: "diameter" }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "bore-feature", bindingVersion: 1, value: 6 }
        })
      );

      expect(result.status).toBe("proved");
      if (result.status === "proved") {
        for (const sample of result.record.samples) {
          expect(sample.geometry.kind).toBe("radial");
          if (sample.geometry.kind === "radial") {
            expect(sample.geometry.regions).toBe(3);
            expect(sample.geometry.diameterMm).toBeCloseTo(sample.paramValues.bore_d as number, 3);
          }
        }

        // Review Q2 calibration evidence: the declared axis is X (axisIndex 0).
        // console.log so the measured value is visible in the gate output
        // regardless of pass/fail (a passing expect's message is not
        // printed by default).
        const drift = maxAxialDrift(result.record, 0);
        console.log(`[calibration] segmented-bores axial-center drift: ${drift.toFixed(6)}mm (target < 0.01mm, enforced bound ${PROOF_THRESHOLDS.radialIdentityAxialToleranceMm}mm)`);
        expect(drift, `measured cross-sample axial-center drift: ${drift.toFixed(6)}mm (target < 0.01mm, enforced bound ${PROOF_THRESHOLDS.radialIdentityAxialToleranceMm}mm)`).toBeLessThan(0.01);
      }
    }, 60_000);
  });

  describe("clamp: radial pipe-bore binding", () => {
    it("proves the pipe bore's diameter, excluding the coaxial outer wall at a different diameter", async () => {
      const scad = await readFile(CLAMP_SCAD, "utf8");
      const schema = await runParamExport(CLAMP_SCAD);
      // Fixture defaults: pipe_dia=32, wall=3 -> outer wall diameter =
      // pipe_dia+2*wall = 38, coaxial with the bore on the same Z axis
      // through the origin -- excluded by the diameter criterion, not an
      // axial or radius-band check.
      const authoritativeParams = { pipe_dia: 32, wall: 3, width: 20, plate: 4, screw_dia: 4.5 };
      const feature: EditorFeature = {
        featureId: "bore-feature",
        label: "Pipe bore",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "radial", parameter: "pipe_dia", center: [0, 0, 0], axis: [0, 0, 1], parameterMeaning: "diameter", presentation: "diameter" }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "bore-feature", bindingVersion: 1, value: 40 }
        })
      );

      expect(result.status).toBe("proved");
      if (result.status === "proved") {
        for (const sample of result.record.samples) {
          expect(sample.geometry.kind).toBe("radial");
          if (sample.geometry.kind === "radial") {
            expect(sample.geometry.regions).toBe(1);
            expect(sample.geometry.diameterMm).toBeCloseTo(sample.paramValues.pipe_dia as number, 3);
          }
        }

        // Review Q2 calibration evidence: the declared axis is Z (axisIndex 2).
        // console.log so the measured value is visible in the gate output
        // regardless of pass/fail (a passing expect's message is not
        // printed by default).
        const drift = maxAxialDrift(result.record, 2);
        console.log(`[calibration] clamp pipe-bore axial-center drift: ${drift.toFixed(6)}mm (target < 0.01mm, enforced bound ${PROOF_THRESHOLDS.radialIdentityAxialToleranceMm}mm)`);
        expect(drift, `measured cross-sample axial-center drift: ${drift.toFixed(6)}mm (target < 0.01mm, enforced bound ${PROOF_THRESHOLDS.radialIdentityAxialToleranceMm}mm)`).toBeLessThan(0.01);
      }
    }, 60_000);

    it("refuses a declared diameter matching neither the bore nor the outer wall", async () => {
      const scad = await readFile(CLAMP_SCAD, "utf8");
      const schema = await runParamExport(CLAMP_SCAD);
      const authoritativeParams = { pipe_dia: 32, wall: 3, width: 20, plate: 4, screw_dia: 4.5 };
      const feature: EditorFeature = {
        featureId: "bore-feature",
        label: "Pipe bore (wrong declared diameter)",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        // parameterMeaning "radius" against pipe_dia (which controls
        // diameter directly) claims an expected diameter of 2*pipe_dia --
        // matches neither the bore (pipe_dia) nor the outer wall
        // (pipe_dia + 2*wall).
        binding: { kind: "radial", parameter: "pipe_dia", center: [0, 0, 0], axis: [0, 0, 1], parameterMeaning: "radius", presentation: "radius" }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "bore-feature", bindingVersion: 1, value: 40 }
        })
      );

      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toMatch(/no circular region matched/);
      }
    }, 60_000);
  });

  describe("radius-boss (test-only fixture): a genuinely radius-valued parameter", () => {
    // Neither the clamp (`pipe_dia`) nor hinge (`pin_d`) fixture has a
    // parameter whose value is a true radius (see this test file's other
    // "refuses a radius-meaning interpretation" cases, and the mocked pass
    // in proof.test.ts) -- this minimal fixture (__fixtures__/radius-boss.scad)
    // gives the radius-meaning check real-engine evidence instead of
    // mock-only evidence.
    it("proves a radius-meaning proof on bore_r through the real render (regions: 1)", async () => {
      const scad = await readFile(RADIUS_BOSS_SCAD, "utf8");
      const schema = await runParamExport(RADIUS_BOSS_SCAD);
      const authoritativeParams = { bore_r: 3 };
      const feature: EditorFeature = {
        featureId: "bore-feature",
        label: "Boss bore",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "radial", parameter: "bore_r", center: [0, 0, 0], axis: [0, 0, 1], parameterMeaning: "radius", presentation: "radius" }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "bore-feature", bindingVersion: 1, value: 4 }
        })
      );

      expect(result.status).toBe("proved");
      if (result.status === "proved") {
        for (const sample of result.record.samples) {
          expect(sample.geometry.kind).toBe("radial");
          if (sample.geometry.kind === "radial") {
            expect(sample.geometry.regions).toBe(1);
            expect(sample.geometry.diameterMm).toBeCloseTo(2 * (sample.paramValues.bore_r as number), 3);
          }
        }
      }
    }, 60_000);

    it("refuses when the same genuinely-radius parameter is mislabeled as diameter", async () => {
      const scad = await readFile(RADIUS_BOSS_SCAD, "utf8");
      const schema = await runParamExport(RADIUS_BOSS_SCAD);
      const authoritativeParams = { bore_r: 3 };
      const feature: EditorFeature = {
        featureId: "bore-feature",
        label: "Boss bore (mislabeled as diameter)",
        projectId: PROJECT_ID,
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "radial", parameter: "bore_r", center: [0, 0, 0], axis: [0, 0, 1], parameterMeaning: "diameter", presentation: "diameter" }
      };

      const result = await runProbe(
        baseRequest({
          scad,
          schema,
          authoritativeParams,
          features: [feature],
          command: { kind: "set-value", featureId: "bore-feature", bindingVersion: 1, value: 4 }
        })
      );

      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toMatch(/no circular region matched/);
      }
    }, 60_000);
  });
});
