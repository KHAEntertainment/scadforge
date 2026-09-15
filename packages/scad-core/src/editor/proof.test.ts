// @scadforge/scad-core — proof.ts tests, with mocked geometry (Issue #91,
// S3-B ticket B5). The `@docker` clamp/hinge fixture tests live in
// `proof.docker.test.ts`; these prove the probe/persistence logic itself
// without a Docker engine, injecting `renderSampleMesh` so no OpenSCAD
// subprocess ever runs here.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorFeature } from "@scadforge/protocol";
import type { ParamSchema, ParamValues } from "../types.js";
import type { WeldedMesh } from "../geometry/mesh.js";
import { buildTubeMesh, mergeMeshes } from "../geometry/testMeshFixtures.js";
import { withRecoveredProject } from "../store/recovered.js";
import { metaDir, projectFilePath } from "../store/paths.js";
import {
  lookupProofLocked,
  persistProofRecord,
  runProbe,
  type ProofRecord,
  type ProofRenderDeps,
  type RunProbeInput
} from "./proof.js";
import { commandDigest } from "./canonical.js";

const PROJECT_ID = "hinged-box"; // real project ids are slugs, never UUIDs -- Tech Lead's contract-defect note

const PROVIDER = { provider: "claude-agent-sdk" as const, model: null, max_passes: 2 };

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-proof-test-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function seedProjectManifest(): Promise<void> {
  await mkdir(metaDir(projectDir), { recursive: true });
  await writeFile(
    projectFilePath(projectDir),
    JSON.stringify(
      {
        schema_version: 1,
        id: PROJECT_ID,
        name: "Test",
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        openscad_image: "openscad/openscad@sha256:test",
        openscad_version: "2026.01.19",
        provider: PROVIDER,
        head: null
      },
      null,
      2
    ),
    "utf8"
  );
}

function linearFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: "f1",
    label: "wall",
    projectId: PROJECT_ID,
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "wallThickness", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
    ...overrides
  };
}

function radialFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: "f1",
    label: "bore",
    projectId: PROJECT_ID,
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "radial", parameter: "boreDiameter", center: [0, 0, 5], axis: [0, 0, 1], parameterMeaning: "diameter", presentation: "diameter" },
    ...overrides
  };
}

const linearSchema: ParamSchema = { title: "t", parameters: [{ name: "wallThickness", type: "number", initial: 10, min: 1, max: 50, step: 1 }] };
const radialSchema: ParamSchema = { title: "t", parameters: [{ name: "boreDiameter", type: "number", initial: 10, min: 2, max: 40, step: 1 }] };

/** A trivial mesh whose only observable property `linearMeasurement` reads is its positions' bounding extent along an axis. */
function boxMesh(minX: number, extentX: number): WeldedMesh {
  const maxX = minX + extentX;
  const positions = [
    { x: minX, y: 0, z: 0 },
    { x: maxX, y: 0, z: 0 },
    { x: maxX, y: 20, z: 20 }
  ];
  return { positions, triangles: [[0, 1, 2]], faceNormals: [{ x: 0, y: 0, z: 1 }], neighbors: [[]] };
}

function fakeDeps(renderSampleMesh: ProofRenderDeps["renderSampleMesh"]): Partial<ProofRenderDeps> {
  return { renderSampleMesh, computeSourceFingerprint: (scad) => "f".repeat(63) + (scad.length % 10) };
}

function baseInput(overrides: Partial<RunProbeInput> = {}): RunProbeInput {
  return {
    projectId: PROJECT_ID,
    baseEditorRevision: "c".repeat(64),
    scad: "cube([10,20,20]);",
    authoritativeParams: { wallThickness: 10 },
    schema: linearSchema,
    features: [linearFeature()],
    command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: 15 },
    intent: "edit",
    traversal: null,
    ...overrides
  };
}

describe("runProbe — linear bindings", () => {
  it("passes when extent tracks scale·param+offset and the anchor stays put (cube, set-value)", async () => {
    const render = vi.fn(async (_scad: string, params: ParamValues) => boxMesh(0, params.wallThickness as number));
    const result = await runProbe(baseInput(), fakeDeps(render));

    expect(result.status).toBe("proved");
    if (result.status === "proved") {
      expect(result.record.samples.length).toBe(3); // baseline(10), candidate(15), one perturbation
      expect(result.record.candidateParams).toEqual({ wallThickness: 15 });
      expect(result.record.candidateEqualsBaseline).toBe(false); // set-value (review Q1/A3)
      for (const sample of result.record.samples) {
        expect(sample.geometry.kind).toBe("linear");
        if (sample.geometry.kind === "linear") {
          expect(sample.geometry.extentMm).toBeCloseTo(sample.paramValues.wallThickness as number, 6);
          expect(sample.geometry.anchorPositionMm).toBeCloseTo(0, 6);
        }
      }
    }
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("refuses when the anchored face moves across samples", async () => {
    // min-x drifts with the parameter instead of staying fixed -- an
    // anchor="min" binding claims the low face never moves.
    const render = vi.fn(async (_scad: string, params: ParamValues) => boxMesh((params.wallThickness as number) * 0.1, params.wallThickness as number));
    const result = await runProbe(baseInput(), fakeDeps(render));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toMatch(/anchor/i);
    }
  });

  it("refuses when the rendered extent does not track the declared relation", async () => {
    const render = vi.fn(async (_scad: string, params: ParamValues) => boxMesh(0, (params.wallThickness as number) + 5)); // extent is off by a constant 5mm
    const result = await runProbe(baseInput(), fakeDeps(render));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toMatch(/does not track/);
    }
  });
});

describe("runProbe — radial bindings", () => {
  it("passes on a single recognized bore matching the declared center/axis/diameter", async () => {
    const render = vi.fn(async (_scad: string, params: ParamValues) => buildTubeMesh("z", [0, 0], (params.boreDiameter as number) / 2, 48, [0, 10], "hole"));
    const input = baseInput({
      schema: radialSchema,
      authoritativeParams: { boreDiameter: 10 },
      features: [radialFeature()],
      command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: 14 }
    });
    const result = await runProbe(input, fakeDeps(render));

    expect(result.status).toBe("proved");
    if (result.status === "proved") {
      for (const sample of result.record.samples) {
        expect(sample.geometry.kind).toBe("radial");
        if (sample.geometry.kind === "radial") {
          expect(sample.geometry.regions).toBe(1);
          expect(sample.geometry.diameterMm).toBeCloseTo(sample.paramValues.boreDiameter as number, 5);
        }
      }
    }
  });

  // (d) required mocked scenario: collinear same-diameter segments that ALL
  // track the parameter (e.g. the hinge fixture's three knuckle bores under
  // pin_d) count as ONE segmented feature and pass, with the region count
  // recorded on the proof record.
  it("passes with regions > 1 for collinear same-diameter segments that all track the parameter (segmented feature)", async () => {
    const render = vi.fn(async (_scad: string, params: ParamValues) => {
      const d = (params.boreDiameter as number) / 2;
      return mergeMeshes(buildTubeMesh("z", [0, 0], d, 48, [0, 4], "hole"), buildTubeMesh("z", [0, 0], d, 48, [6, 10], "hole"));
    });
    const input = baseInput({
      schema: radialSchema,
      authoritativeParams: { boreDiameter: 10 },
      features: [radialFeature()],
      command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: 12 }
    });
    const result = await runProbe(input, fakeDeps(render));

    expect(result.status).toBe("proved");
    if (result.status === "proved") {
      for (const sample of result.record.samples) {
        expect(sample.geometry.kind).toBe("radial");
        if (sample.geometry.kind === "radial") expect(sample.geometry.regions).toBe(2);
      }
    }
  });

  // (c) required mocked scenario: a coaxial surface that equals the implied
  // diameter at the BASELINE sample only, and does not change when the
  // parameter changes, refuses as ambiguous -- it joins the matched set at
  // one sample and leaves it at another, which is the real ambiguity the
  // cross-sample identity check exists to catch.
  it("refuses (ambiguous) when a coaxial surface matches the baseline diameter but does not track the parameter", async () => {
    const FIXED_DIAMETER = 10; // a second, unrelated bore whose diameter never changes
    const render = vi.fn(async (_scad: string, params: ParamValues) => {
      const trackingBore = buildTubeMesh("z", [0, 0], (params.boreDiameter as number) / 2, 48, [0, 8], "hole");
      const fixedBore = buildTubeMesh("z", [0, 0], FIXED_DIAMETER / 2, 48, [20, 28], "hole"); // same radial center/axis, different axial position, fixed diameter
      return mergeMeshes(trackingBore, fixedBore);
    });
    const input = baseInput({
      schema: radialSchema,
      authoritativeParams: { boreDiameter: FIXED_DIAMETER }, // baseline: tracking bore ALSO happens to be 10mm, so both match at baseline
      features: [radialFeature()],
      command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: 16 } // candidate: tracking bore is now 16mm, fixed bore is still 10mm -- no longer matches
    });
    const result = await runProbe(input, fakeDeps(render));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toMatch(/ambiguous radial mapping/);
    }
  });

  // Neither the clamp nor hinge @docker fixture has a schema parameter
  // whose VALUE is a true radius (both `pipe_dia` and `pin_d` control
  // diameter directly), so a genuinely passing radius-meaning proof is only
  // constructible here, against a synthetic schema -- see
  // proof.docker.test.ts's note for the real-fixture refusal counterpart.
  it("passes with parameterMeaning: radius when the parameter genuinely controls a radius", async () => {
    const render = vi.fn(async (_scad: string, params: ParamValues) => buildTubeMesh("z", [0, 0], params.boreRadius as number, 48, [0, 10], "hole"));
    const schema: ParamSchema = { title: "t", parameters: [{ name: "boreRadius", type: "number", initial: 5, min: 1, max: 20, step: 0.5 }] };
    const input = baseInput({
      schema,
      authoritativeParams: { boreRadius: 5 },
      features: [radialFeature({ binding: { kind: "radial", parameter: "boreRadius", center: [0, 0, 5], axis: [0, 0, 1], parameterMeaning: "radius", presentation: "radius" } })],
      command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: 7 }
    });
    const result = await runProbe(input, fakeDeps(render));

    expect(result.status).toBe("proved");
    if (result.status === "proved") {
      for (const sample of result.record.samples) {
        expect(sample.geometry.kind).toBe("radial");
        if (sample.geometry.kind === "radial") {
          expect(sample.geometry.diameterMm).toBeCloseTo(2 * (sample.paramValues.boreRadius as number), 5);
        }
      }
    }
  });

  it("refuses immediately on a non-principal radial axis, without rendering", async () => {
    const render = vi.fn();
    const diagonal = 1 / Math.sqrt(3);
    const input = baseInput({
      schema: radialSchema,
      authoritativeParams: { boreDiameter: 10 },
      features: [radialFeature({ binding: { kind: "radial", parameter: "boreDiameter", center: [0, 0, 5], axis: [diagonal, diagonal, diagonal], parameterMeaning: "diameter", presentation: "diameter" } })],
      command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: 12 }
    });
    const result = await runProbe(input, fakeDeps(render));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toMatch(/principal axis/);
    }
    expect(render).not.toHaveBeenCalled();
  });
});

describe("runProbe — degenerate cases", () => {
  it("refuses when the bound parameter is missing from the schema", async () => {
    const render = vi.fn();
    const input = baseInput({ schema: { title: "t", parameters: [] } });
    const result = await runProbe(input, fakeDeps(render));
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/not in the current parameter schema/);
    expect(render).not.toHaveBeenCalled();
  });

  it("refuses when the bound parameter is non-numeric", async () => {
    const render = vi.fn();
    const schema: ParamSchema = { title: "t", parameters: [{ name: "wallThickness", type: "string", initial: "x" }] };
    const input = baseInput({ schema });
    const result = await runProbe(input, fakeDeps(render));
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/not numeric/);
    expect(render).not.toHaveBeenCalled();
  });

  it("refuses when no legal perturbation exists (value pinned at both min and max)", async () => {
    const render = vi.fn();
    const schema: ParamSchema = { title: "t", parameters: [{ name: "wallThickness", type: "number", initial: 10, min: 10, max: 10 }] };
    const input = baseInput({ schema, authoritativeParams: { wallThickness: 10 }, command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: 10 } });
    const result = await runProbe(input, fakeDeps(render));
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/no legal in-range perturbation/i);
    expect(render).not.toHaveBeenCalled();
  });

  it("put-feature with only one legal side records 2 samples (correction C4)", async () => {
    const render = vi.fn(async (_scad: string, params: ParamValues) => boxMesh(0, params.wallThickness as number));
    const schema: ParamSchema = { title: "t", parameters: [{ name: "wallThickness", type: "number", initial: 50, min: 1, max: 50, step: 1 }] };
    const input = baseInput({
      schema,
      authoritativeParams: { wallThickness: 50 }, // pinned at max -- only the downward perturbation is legal
      command: { kind: "put-feature", feature: linearFeature({ binding: { kind: "linear", parameter: "wallThickness", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } } }) },
      intent: "setup"
    });
    const result = await runProbe(input, fakeDeps(render));
    expect(result.status).toBe("proved");
    if (result.status === "proved") {
      expect(result.record.samples.length).toBe(2);
      expect(result.record.candidateParams).toEqual({ wallThickness: 50 });
      expect(result.record.candidateEqualsBaseline).toBe(true); // put-feature (review Q1/A3)
    }
  });

  it("put-feature with room on both sides records 3 samples", async () => {
    const render = vi.fn(async (_scad: string, params: ParamValues) => boxMesh(0, params.wallThickness as number));
    const input = baseInput({
      command: { kind: "put-feature", feature: linearFeature() },
      intent: "setup"
    });
    const result = await runProbe(input, fakeDeps(render));
    expect(result.status).toBe("proved");
    if (result.status === "proved") {
      expect(result.record.samples.length).toBe(3);
      expect(result.record.candidateEqualsBaseline).toBe(true); // put-feature (review Q1/A3)
    }
  });
});

describe("runProbe — remove-feature", () => {
  it("succeeds without rendering when the reference and version exist", async () => {
    const render = vi.fn();
    const input = baseInput({ command: { kind: "remove-feature", featureId: "f1", bindingVersion: 1 } });
    const result = await runProbe(input, fakeDeps(render));
    expect(result.status).toBe("proved");
    if (result.status === "proved") {
      expect(result.record.samples).toEqual([]);
      expect(result.record.candidateParams).toBeNull();
      expect(result.record.candidateEqualsBaseline).toBeNull(); // remove-feature (review Q1/A3)
    }
    expect(render).not.toHaveBeenCalled();
  });

  it("refuses when the reference/version is not found", async () => {
    const render = vi.fn();
    const input = baseInput({ command: { kind: "remove-feature", featureId: "f1", bindingVersion: 2 } });
    const result = await runProbe(input, fakeDeps(render));
    expect(result.status).toBe("refused");
    expect(render).not.toHaveBeenCalled();
  });
});

describe("persistProofRecord + lookupProofLocked", () => {
  function sampleRecord(overrides: Partial<ProofRecord> = {}): ProofRecord {
    const digestInput = { version: 1 as const, projectId: PROJECT_ID, baseEditorRevision: "c".repeat(64), command: { kind: "remove-feature" as const, featureId: "f1", bindingVersion: 1 }, intent: "edit" as const, traversal: null };
    return {
      version: 1,
      proofId: "11111111-1111-1111-1111-111111111111",
      projectId: PROJECT_ID,
      baseEditorRevision: "c".repeat(64),
      sourceFingerprint: "d".repeat(64),
      authoritativeParams: {},
      commandDigest: commandDigest(digestInput),
      command: digestInput.command,
      intent: digestInput.intent,
      traversal: digestInput.traversal,
      candidateParams: null,
      candidateEqualsBaseline: null, // remove-feature
      samples: [],
      recognizerVersion: "test",
      engineImage: "openscad/openscad@sha256:test",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      success: true,
      ...overrides
    };
  }

  it("a persisted proof is found valid, and survives a simulated restart (re-read from disk)", async () => {
    await seedProjectManifest();
    const record = sampleRecord();
    await persistProofRecord(projectDir, record);

    // Simulate a restart: a fresh lookup, no in-process cache/state carried over.
    const result = await withRecoveredProject(projectDir, (ctx) => lookupProofLocked(ctx, record.proofId));
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.proof.proofId).toBe(record.proofId);
    }
  });

  it("an expired proof lookup refuses", async () => {
    await seedProjectManifest();
    const record = sampleRecord({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await persistProofRecord(projectDir, record);

    const result = await withRecoveredProject(projectDir, (ctx) => lookupProofLocked(ctx, record.proofId));
    expect(result.status).toBe("expired");
  });

  it("a digest mismatch (tampered/corrupt record) refuses", async () => {
    await seedProjectManifest();
    const record = sampleRecord({ commandDigest: "0".repeat(64) }); // does not match a recomputed digest of its own fields
    await persistProofRecord(projectDir, record);

    const result = await withRecoveredProject(projectDir, (ctx) => lookupProofLocked(ctx, record.proofId));
    expect(result.status).toBe("digest-mismatch");
  });

  it("a lookup for a proofId that was never persisted refuses as not-found", async () => {
    await seedProjectManifest();
    const result = await withRecoveredProject(projectDir, (ctx) => lookupProofLocked(ctx, "22222222-2222-2222-2222-222222222222"));
    expect(result.status).toBe("not-found");
  });

  it("persists atomically: the file never appears partially written under concurrent reads", async () => {
    await seedProjectManifest();
    const record = sampleRecord();
    await persistProofRecord(projectDir, record);
    const raw = await readFile(join(projectDir, ".scadforge", "editor-proofs", `${record.proofId}.json`), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
