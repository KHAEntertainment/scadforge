// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Axis, Vec3 } from "../measure.js";
import { angularCoverage, classifySurface, evaluateCylinder, fitCircleInPlane, sagittaMm } from "./cylinderFit.js";
import { INSPECTION_THRESHOLDS } from "./thresholds.js";
import type { Refusal } from "./inspectionTypes.js";

const TAU = Math.PI * 2;

/** Places a (u, v, axial) triple into 3D using the same cyclic axis convention as cylinderFit.ts: x → (y, z), y → (z, x), z → (x, y). */
function fromUV(axis: Axis, u: number, v: number, axial: number): Vec3 {
  switch (axis) {
    case "x":
      return { x: axial, y: u, z: v };
    case "y":
      return { x: v, y: axial, z: u };
    case "z":
      return { x: u, y: v, z: axial };
  }
}

/**
 * An OpenSCAD-style vertex ring: `facetIndices` (out of `fn` total) at
 * true polygon-vertex positions on the modeled circle, replicated at
 * each axial level, with outward- or inward-pointing radial normals.
 */
function ring(
  axis: Axis,
  center: [number, number],
  radius: number,
  fn: number,
  facetIndices: number[],
  axialValues: number[],
  orientation: "outward" | "inward" = "outward"
): { vertices: Vec3[]; normals: Vec3[] } {
  const vertices: Vec3[] = [];
  const normals: Vec3[] = [];
  for (const i of facetIndices) {
    const angle = (i / fn) * TAU;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const u = center[0] + radius * cos;
    const v = center[1] + radius * sin;
    const nu = orientation === "outward" ? cos : -cos;
    const nv = orientation === "outward" ? sin : -sin;
    for (const axial of axialValues) {
      vertices.push(fromUV(axis, u, v, axial));
      normals.push(fromUV(axis, nu, nv, 0));
    }
  }
  return { vertices, normals };
}

function fullRing(axis: Axis, center: [number, number], radius: number, fn: number, axialValues: number[], orientation: "outward" | "inward" = "outward") {
  return ring(axis, center, radius, fn, Array.from({ length: fn }, (_, i) => i), axialValues, orientation);
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && "code" in value;
}

describe("fitCircleInPlane", () => {
  it("recovers a small feature's diameter and center within 1e-6 mm far from the origin (fit conditioning)", () => {
    const axis: Axis = "z";
    const diameter = 4.5;
    const radius = diameter / 2;
    const fn = 48;

    for (const center of [
      [150, 150],
      [-300, 80]
    ] as const) {
      const { vertices } = fullRing(axis, [center[0], center[1]], radius, fn, [0]);
      const fit = fitCircleInPlane(axis, vertices);

      expect(Math.abs(fit.radius * 2 - diameter)).toBeLessThan(1e-6);
      expect(Math.abs(fit.center.x - center[0])).toBeLessThan(1e-6);
      expect(Math.abs(fit.center.y - center[1])).toBeLessThan(1e-6);
    }
  });

  it("recovers the exact modeled radius and center for $fn = 12, 48, 96, including translated centers", () => {
    const cases: { axis: Axis; center: [number, number]; radius: number; fn: number }[] = [
      { axis: "z", center: [0, 0], radius: 16, fn: 12 },
      { axis: "x", center: [12.5, -7.25], radius: 20, fn: 48 },
      { axis: "y", center: [-4, 33.1], radius: 8.75, fn: 96 }
    ];

    for (const { axis, center, radius, fn } of cases) {
      const { vertices } = fullRing(axis, center, radius, fn, [0, 20]);
      const fit = fitCircleInPlane(axis, vertices);

      expect(fit.radius).toBeCloseTo(radius, 9);
      expect(fit.maxDeviationMm).toBeLessThan(1e-9);

      // The fitted 3D center: axial coordinate is the region's axial
      // midpoint (here (0+20)/2 = 10); the free coordinates match the
      // translated 2D center.
      if (axis === "z") {
        expect(fit.center.x).toBeCloseTo(center[0], 9);
        expect(fit.center.y).toBeCloseTo(center[1], 9);
        expect(fit.center.z).toBeCloseTo(10, 9);
      } else if (axis === "x") {
        expect(fit.center.x).toBeCloseTo(10, 9);
        expect(fit.center.y).toBeCloseTo(center[0], 9);
        expect(fit.center.z).toBeCloseTo(center[1], 9);
      } else {
        expect(fit.center.y).toBeCloseTo(10, 9);
        expect(fit.center.z).toBeCloseTo(center[0], 9);
        expect(fit.center.x).toBeCloseTo(center[1], 9);
      }
    }
  });

  it("counterexample: fitting facet midpoints under-reads by cos(π/$fn), while fitting the true vertices does not", () => {
    const axis: Axis = "z";
    const fn = 12;
    const radius = 20;
    const { vertices } = fullRing(axis, [0, 0], radius, fn, [0]);

    const vertexFit = fitCircleInPlane(axis, vertices);
    expect(vertexFit.radius).toBeCloseTo(radius, 9);

    // Facet midpoints: the average of each pair of adjacent true
    // vertices, i.e. the apothem circle — the trap a naive "measure to
    // the facet" implementation would fall into.
    const midpoints: Vec3[] = vertices.map((v, i) => {
      const next = vertices[(i + 1) % vertices.length];
      return { x: (v.x + next.x) / 2, y: (v.y + next.y) / 2, z: (v.z + next.z) / 2 };
    });
    const midpointFit = fitCircleInPlane(axis, midpoints);
    const expectedApothem = radius * Math.cos(Math.PI / fn);

    expect(midpointFit.radius).toBeCloseTo(expectedApothem, 9);
    expect(Math.abs(midpointFit.radius - radius)).toBeGreaterThan(0.1);
  });

  it("stays under the deviation limit for noise at 1e-5 mm", () => {
    const axis: Axis = "z";
    const fn = 48;
    const radius = 20;
    const { vertices } = fullRing(axis, [0, 0], radius, fn, [0]);

    const noisy: Vec3[] = vertices.map((v, i) => {
      const delta = 1e-5 * (i % 2 === 0 ? 1 : -1);
      return { x: v.x + delta, y: v.y + delta, z: v.z };
    });

    const fit = fitCircleInPlane(axis, noisy);
    expect(fit.maxDeviationMm).toBeLessThan(INSPECTION_THRESHOLDS.maxDeviationMm);
  });
});

describe("angularCoverage", () => {
  it("reports a fully closed ring as exactly 360°, for $fn = 12, 48 and 96", () => {
    const axis: Axis = "z";
    for (const fn of [12, 48, 96]) {
      const { vertices } = fullRing(axis, [0, 0], 20, fn, [0]);
      const fit = fitCircleInPlane(axis, vertices);
      const { arcDegrees, segments } = angularCoverage(axis, vertices, fit.center);
      expect(arcDegrees).toBe(360);
      expect(segments).toBe(fn);
    }
  });

  it("reports partial arcs of 90°, 180° and 330° from a genuinely missing facet run, and still recovers the full segment count", () => {
    const axis: Axis = "z";
    const fn = 48; // 7.5° per facet
    const radius = 20;
    const cases: { coveredFacets: number; expectedDeg: number }[] = [
      { coveredFacets: 12, expectedDeg: 90 }, // 12 * 7.5 = 90
      { coveredFacets: 24, expectedDeg: 180 }, // 24 * 7.5 = 180
      { coveredFacets: 44, expectedDeg: 330 } // 44 * 7.5 = 330
    ];

    for (const { coveredFacets, expectedDeg } of cases) {
      const facetIndices = Array.from({ length: coveredFacets + 1 }, (_, i) => i); // vertices 0..coveredFacets inclusive
      const { vertices } = ring(axis, [0, 0], radius, fn, facetIndices, [0, 10]);
      const fit = fitCircleInPlane(axis, vertices);
      const { arcDegrees, segments } = angularCoverage(axis, vertices, fit.center);

      expect(arcDegrees).toBeCloseTo(expectedDeg, 6);
      expect(segments).toBe(fn);
    }
  });
});

describe("classifySurface", () => {
  it("classifies outward-pointing normals as an outside surface and inward-pointing normals as a hole", () => {
    const axis: Axis = "z";
    const { vertices: outVerts, normals: outNormals } = fullRing(axis, [0, 0], 20, 48, [0]);
    const { vertices: inVerts, normals: inNormals } = fullRing(axis, [0, 0], 20, 48, [0], "inward");

    const outsideFit = fitCircleInPlane(axis, outVerts);
    const holeFit = fitCircleInPlane(axis, inVerts);

    expect(classifySurface(axis, outVerts, outNormals, outsideFit.center)).toBe("outside");
    expect(classifySurface(axis, inVerts, inNormals, holeFit.center)).toBe("hole");
  });
});

describe("evaluateCylinder", () => {
  it("recognizes a full ring as a cylinder, hole or outside depending on normal orientation", () => {
    const axis: Axis = "y";
    const radius = 12;
    const fn = 48;

    const { vertices: holeVerts, normals: holeNormals } = fullRing(axis, [3, -2], radius, fn, [5, 25], "inward");
    const hole = evaluateCylinder(axis, holeVerts, holeNormals);
    expect(isRefusal(hole)).toBe(false);
    if (!isRefusal(hole)) {
      expect(hole.kind).toBe("radial");
      expect(hole.surface).toBe("hole");
      expect(hole.axis).toBe(axis);
      expect(hole.diameterMm).toBeCloseTo(radius * 2, 9);
      expect(hole.evidence.segments).toBe(fn);
      expect(hole.evidence.maxDeviationMm).toBeLessThan(1e-9);
      expect(hole.evidence.axialLengthMm).toBeCloseTo(20, 9);
    }

    const { vertices: outVerts, normals: outNormals } = fullRing(axis, [3, -2], radius, fn, [5, 25], "outward");
    const outside = evaluateCylinder(axis, outVerts, outNormals);
    expect(isRefusal(outside)).toBe(false);
    if (!isRefusal(outside)) {
      expect(outside.surface).toBe("outside");
    }
  });

  it("refuses too-coarse with the right {n} for 6- and 8-segment rings", () => {
    for (const fn of [6, 8]) {
      const { vertices, normals } = fullRing("z", [0, 0], 10, fn, [0]);
      const outcome = evaluateCylinder("z", vertices, normals);
      expect(isRefusal(outcome)).toBe(true);
      if (isRefusal(outcome)) {
        expect(outcome.code).toBe("too-coarse");
        expect(outcome.message).toContain(`only ${fn} segments`);
      }
    }
  });

  it("refuses partial-arc below the 180° minimum", () => {
    const axis: Axis = "z";
    const fn = 48;
    // 12 covered facets out of 48 => 90° of coverage, well under 180°.
    const facetIndices = Array.from({ length: 13 }, (_, i) => i);
    const { vertices, normals } = ring(axis, [0, 0], 20, fn, facetIndices, [0]);
    const outcome = evaluateCylinder(axis, vertices, normals);
    expect(isRefusal(outcome)).toBe(true);
    if (isRefusal(outcome)) {
      expect(outcome.code).toBe("partial-arc");
    }
  });

  it("refuses not-circular for an ellipse (non-uniform scale)", () => {
    const axis: Axis = "z";
    const fn = 48;
    const rx = 20;
    const ry = 24; // non-uniform scale: a true ellipse, not a circle
    const vertices: Vec3[] = [];
    const normals: Vec3[] = [];
    for (let i = 0; i < fn; i++) {
      const angle = (i / fn) * TAU;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      vertices.push({ x: rx * cos, y: ry * sin, z: 0 });
      normals.push({ x: cos, y: sin, z: 0 });
    }
    const outcome = evaluateCylinder(axis, vertices, normals);
    expect(isRefusal(outcome)).toBe(true);
    if (isRefusal(outcome)) {
      expect(outcome.code).toBe("not-circular");
    }
  });

  it("refuses planar for degenerate (collinear) input: a flat strip has no unique circle", () => {
    const axis: Axis = "z";
    // A flat strip: all points share y = 5, varying only in x -- collinear
    // in the projection plane, so the Kasa normal equations are singular.
    const vertices: Vec3[] = [0, 10, 20, 30, 40].map((x) => ({ x, y: 5, z: 0 }));
    const normals: Vec3[] = vertices.map(() => ({ x: 0, y: 1, z: 0 }));

    const outcome = evaluateCylinder(axis, vertices, normals);
    expect(isRefusal(outcome)).toBe(true);
    if (isRefusal(outcome)) {
      expect(outcome.code).toBe("planar");
      expect(outcome.message).toBe("This is a flat surface. Surface inspection measures cylindrical walls only.");
    }
  });
});

// S2-1 fixup 2 (tickets/s2-1-cylinder-fit/fixup-2): boolean seams — where
// another body meets the wall — add vertices that sit on the facet CHORD
// between two real polygon vertices, not on the circle itself. Found by the
// S2-3 `@docker` fixture run: the clamp's outer ring (every wall) and its
// wall-2 pipe bore (a screw hole breaking into it) both carry such seams.
describe("evaluateCylinder — robust fit against boolean-seam vertices (S2-1 fixup 2)", () => {
  it("refuses an inward axial ring even when retained rings still span the full height", () => {
    const outer = fullRing("z", [0, 0], 20.05, 48, [0, 10]);
    const inner = fullRing("z", [0, 0], 20, 48, [5, 5]);
    const outcome = evaluateCylinder("z", [...outer.vertices, ...inner.vertices], [...outer.normals, ...inner.normals]);
    expect(isRefusal(outcome)).toBe(true);
    if (isRefusal(outcome)) expect(outcome.code).toBe("not-circular");
  });

  it("recognizes a ring with extra seam vertices sitting exactly on facet chords, recovering the exact diameter and center", () => {
    const axis: Axis = "z";
    const fn = 48;
    const radius = 20;
    const { vertices, normals } = fullRing(axis, [0, 0], radius, fn, [0, 20]);

    // Simulated boolean seam: extra vertices at several angular midpoints
    // between adjacent real vertices (i.e. on the facet chord), at the
    // sagitta depth, across a handful of axial rows in between the two
    // real ones -- exactly the shape a body intersecting the wall leaves.
    const sagitta = sagittaMm(radius, fn);
    const seamVertices: Vec3[] = [];
    const seamNormals: Vec3[] = [];
    for (const facetIndex of [3, 10, 25, 40]) {
      const midAngle = ((facetIndex + 0.5) / fn) * TAU;
      const cos = Math.cos(midAngle);
      const sin = Math.sin(midAngle);
      const chordRadius = radius - sagitta;
      for (const axial of [3, 9, 15]) {
        seamVertices.push(fromUV(axis, chordRadius * cos, chordRadius * sin, axial));
        seamNormals.push(fromUV(axis, cos, sin, 0));
      }
    }

    const outcome = evaluateCylinder(axis, [...vertices, ...seamVertices], [...normals, ...seamNormals]);
    expect(isRefusal(outcome)).toBe(false);
    if (!isRefusal(outcome)) {
      expect(outcome.diameterMm).toBeCloseTo(radius * 2, 6);
      expect(outcome.center.x).toBeCloseTo(0, 6);
      expect(outcome.center.y).toBeCloseTo(0, 6);
      expect(outcome.evidence.segments).toBe(fn);
      expect(outcome.evidence.arcDegrees).toBe(360);
      expect(outcome.evidence.maxDeviationMm).toBeLessThan(1e-6);
      expect(outcome.evidence.axialLengthMm).toBe(20);
      expect(outcome.center.z).toBe(10);
    }
  });

  it("refuses not-circular immediately when a single vertex sits 0.02mm outside the fit (rule 5)", () => {
    const axis: Axis = "z";
    const fn = 48;
    const radius = 20;
    const { vertices, normals } = fullRing(axis, [0, 0], radius, fn, [0, 20]);

    const pushed = vertices.map((v) => ({ ...v }));
    const angle = Math.atan2(pushed[0].y, pushed[0].x);
    const pushedRadius = radius + 0.02; // comfortably past maxDeviationMm (0.01)
    pushed[0] = { x: pushedRadius * Math.cos(angle), y: pushedRadius * Math.sin(angle), z: pushed[0].z };

    const outcome = evaluateCylinder(axis, pushed, normals);
    expect(isRefusal(outcome)).toBe(true);
    if (isRefusal(outcome)) {
      expect(outcome.code).toBe("not-circular");
    }
  });

  it("refuses not-circular when a dropped vertex lies inside by more than the sagitta band (rule 4)", () => {
    const axis: Axis = "z";
    const fn = 48;
    const radius = 20;
    const { vertices, normals } = fullRing(axis, [0, 0], radius, fn, [0, 20]);

    const sagitta = sagittaMm(radius, fn);
    const tooDeepMm = sagitta + INSPECTION_THRESHOLDS.maxDeviationMm + 0.01; // clearly past the allowed band
    const pushed = vertices.map((v) => ({ ...v }));
    const angle = Math.atan2(pushed[0].y, pushed[0].x);
    const pushedRadius = radius - tooDeepMm;
    pushed[0] = { x: pushedRadius * Math.cos(angle), y: pushedRadius * Math.sin(angle), z: pushed[0].z };

    const outcome = evaluateCylinder(axis, pushed, normals);
    expect(isRefusal(outcome)).toBe(true);
    if (isRefusal(outcome)) {
      expect(outcome.code).toBe("not-circular");
    }
  });
});
