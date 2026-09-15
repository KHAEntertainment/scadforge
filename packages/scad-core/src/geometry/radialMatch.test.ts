// @scadforge/scad-core — radialMatch.ts tests (Issue #91, S3-B ticket B5,
// correction C3; match-criteria ruling recorded in this file's header). The
// `@docker` hinge/clamp fixtures in `../editor/proof.docker.test.ts` cover
// the real-render end-to-end case; these prove the seeded-scan algorithm's
// SINGLE-SAMPLE match criteria (axis + axis-line distance + diameter)
// against hand-built meshes. The cross-sample region-identity comparison
// (module header's "same set of regions, by region identity, in every
// sample") is `../editor/proof.ts`'s concern, tested in `proof.test.ts`.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { findRadialMatches } from "./radialMatch.js";
import { buildTubeMesh, mergeMeshes } from "./testMeshFixtures.js";

describe("findRadialMatches", () => {
  it("finds exactly one match for a single bore at the declared center and diameter", () => {
    const mesh = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole");
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 5 }, "z", 10);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].diameterMm).toBeCloseTo(10, 6);
    expect(result.matches[0].surface).toBe("hole");
  });

  it("finds zero matches when the declared center doesn't correspond to any bore", () => {
    const mesh = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole");
    const result = findRadialMatches(mesh, { x: 100, y: 100, z: 5 }, "z", 10);
    expect(result.matches.length).toBe(0);
  });

  // (a) required mocked scenario: a coaxial bore plus its own outer wall,
  // binding names the bore -- passes with exactly the bore, the wall
  // excluded by the diameter criterion (not an axial or radius-band check).
  it("a coaxial bore plus outer wall: naming the bore's diameter matches only the bore", () => {
    const bore = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole"); // diameter 10
    const wall = buildTubeMesh("z", [0, 0], 8, 48, [0, 10], "outside"); // diameter 16
    const mesh = mergeMeshes(bore, wall);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 5 }, "z", 10);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].surface).toBe("hole");
    expect(result.matches[0].diameterMm).toBeCloseTo(10, 6);
  });

  // (b) required mocked scenario: the same coaxial bore+wall fixture, but
  // the declared diameter matches NEITHER surface -- refuses (zero matches).
  it("a coaxial bore plus outer wall: a diameter matching neither refuses (zero matches)", () => {
    const bore = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole"); // diameter 10
    const wall = buildTubeMesh("z", [0, 0], 8, 48, [0, 10], "outside"); // diameter 16
    const mesh = mergeMeshes(bore, wall);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 5 }, "z", 13); // between the two, matches neither
    expect(result.matches.length).toBe(0);
  });

  it("collinear same-diameter bores at different axial positions BOTH match when the declared diameter fits both (axial position is not a match criterion here -- see proof.ts for cross-sample identity)", () => {
    const near = buildTubeMesh("z", [0, 0], 5, 48, [0, 8], "hole");
    const far = buildTubeMesh("z", [0, 0], 5, 48, [20, 28], "hole");
    const mesh = mergeMeshes(near, far);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 4 }, "z", 10);
    expect(result.matches.length).toBe(2);
  });

  it("does not match a bore at a different radial position (declared center identifies a specific hole)", () => {
    const near = buildTubeMesh("z", [0, 0], 5, 48, [0, 10], "hole");
    const far = buildTubeMesh("z", [50, 50], 5, 48, [0, 10], "hole");
    const mesh = mergeMeshes(near, far);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 5 }, "z", 10);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].center.x).toBeCloseTo(0, 6);
    expect(result.matches[0].center.y).toBeCloseTo(0, 6);
  });

  it("visits at most the mesh's own face count (bounded runtime, C3)", () => {
    const a = buildTubeMesh("z", [0, 0], 5, 48, [0, 8], "hole");
    const b = buildTubeMesh("z", [40, 40], 8, 48, [0, 8], "outside");
    const mesh = mergeMeshes(a, b);
    const result = findRadialMatches(mesh, { x: 0, y: 0, z: 4 }, "z", 10);
    expect(result.facesVisited).toBeLessThanOrEqual(mesh.triangles.length);
  });
});
