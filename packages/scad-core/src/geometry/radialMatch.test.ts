// @scadforge/scad-core — radialMatch.ts tests (Issue #91, S3-B ticket B5,
// correction C3). The `@docker` hinge/clamp fixtures in
// `../editor/proof.docker.test.ts` cover the real-render end-to-end case;
// these prove the seeded-scan algorithm itself against hand-built meshes:
// zero/one/multiple matches, center-mismatch, and the runtime bound.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { findRadialMatches } from "./radialMatch.js";
import { buildTubeMesh, mergeMeshes } from "./testMeshFixtures.js";

describe("findRadialMatches", () => {
  it("finds exactly one match for a single bore at the declared center", () => {
    const mesh = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole");
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 5 }, "z");
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].diameterMm).toBeCloseTo(10, 6);
    expect(result.matches[0].surface).toBe("hole");
  });

  it("finds zero matches when the declared center doesn't correspond to any bore", () => {
    const mesh = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole");
    const result = findRadialMatches(mesh, { x: 100, y: 100, z: 5 }, "z");
    expect(result.matches.length).toBe(0);
  });

  it("finds two matches (refuse-worthy) for two bores sharing a declared axis/center within tolerance", () => {
    // Two coaxial bores at the same nominal center (e.g. a through-hole
    // rendered as two separate cylindrical segments interrupted by an
    // internal wall) -- both match the declared binding, so the caller
    // (proof.ts) must refuse on ambiguity.
    const a = buildTubeMesh("z", [0, 0], 5, 48, [0, 8], "hole");
    const b = buildTubeMesh("z", [0, 0], 5, 48, [12, 20], "hole");
    const mesh = mergeMeshes(a, b);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 10 }, "z");
    expect(result.matches.length).toBe(2);
  });

  it("does not match a bore at a different radial position (declared center identifies a specific hole)", () => {
    const near = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole");
    const far = buildTubeMesh("z", [50, 50], 5, 48, [0, 10], "hole");
    const mesh = mergeMeshes(near, far);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 5 }, "z");
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].center.x).toBeCloseTo(0, 6);
    expect(result.matches[0].center.y).toBeCloseTo(0, 6);
  });

  it("visits at most the mesh's own face count (bounded runtime, C3)", () => {
    const a = buildTubeMesh("z", [0, 0], 5, 48, [0, 8], "hole");
    const b = buildTubeMesh("z", [40, 40], 8, 48, [0, 8], "outside");
    const mesh = mergeMeshes(a, b);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 4 }, "z");
    expect(result.facesVisited).toBeLessThanOrEqual(mesh.triangles.length);
  });

  it("recognizes a diameter-tracking change: same declared center/axis, different radius still matches (proof.ts checks the diameter separately)", () => {
    const mesh = buildTubeMesh("z", [0, 0], 7, 48, [0, 10], "hole");
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 5 }, "z");
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].diameterMm).toBeCloseTo(14, 6);
  });
});
