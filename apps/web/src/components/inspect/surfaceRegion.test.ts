import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry } from "three";
import { inspectSurface } from "./surfaceRegion.js";

const TAU = Math.PI * 2;

type Point = [number, number, number];
type Tri = [Point, Point, Point];

function faceNormalArr(a: Point, b: Point, c: Point): Point {
  const e1: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1];
  const cy = e1[2] * e2[0] - e1[0] * e2[2];
  const cz = e1[0] * e2[1] - e1[1] * e2[0];
  const len = Math.hypot(cx, cy, cz) || 1;
  return [cx / len, cy / len, cz / len];
}

/**
 * A non-indexed BufferGeometry with per-face `normal` (computed from
 * each triangle's own vertices and duplicated across its 3 vertices) --
 * the shape the STL loader returns, and what `surfaceRegion.ts` must
 * weld a position-only clone of rather than trust directly.
 */
function buildSTLLikeGeometry(triangles: readonly Tri[]): BufferGeometry {
  const position = new Float32Array(triangles.length * 9);
  const normal = new Float32Array(triangles.length * 9);
  triangles.forEach((tri, ti) => {
    const n = faceNormalArr(tri[0], tri[1], tri[2]);
    tri.forEach((p, vi) => {
      const off = ti * 9 + vi * 3;
      position[off] = p[0];
      position[off + 1] = p[1];
      position[off + 2] = p[2];
      normal[off] = n[0];
      normal[off + 1] = n[1];
      normal[off + 2] = n[2];
    });
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("normal", new BufferAttribute(normal, 3));
  return geometry;
}

/**
 * A cylindrical side wall around the Z axis, covering `coveredFacets`
 * out of `fn` total facets (default: the whole ring), between axial
 * levels z0 and z1. `orientation` picks outward (a solid's outside
 * surface) or inward (a bore/hole) winding.
 */
function ringWall(fn: number, radius: number, z0: number, z1: number, options: { coveredFacets?: number; orientation?: "outward" | "inward" } = {}): Tri[] {
  const coveredFacets = options.coveredFacets ?? fn;
  const orientation = options.orientation ?? "outward";
  const tris: Tri[] = [];
  for (let i = 0; i < coveredFacets; i++) {
    const a0 = (i / fn) * TAU;
    const a1 = ((i + 1) / fn) * TAU;
    const p0: Point = [radius * Math.cos(a0), radius * Math.sin(a0), z0];
    const p1: Point = [radius * Math.cos(a1), radius * Math.sin(a1), z0];
    const p2: Point = [radius * Math.cos(a1), radius * Math.sin(a1), z1];
    const p3: Point = [radius * Math.cos(a0), radius * Math.sin(a0), z1];
    const quad: Tri[] = [
      [p0, p1, p2],
      [p0, p2, p3]
    ];
    for (const t of quad) tris.push(orientation === "outward" ? t : [t[0], t[2], t[1]]);
  }
  return tris;
}

/** A flat annular disc at height `z`, fanned from the center -- an end cap. */
function diskCap(fn: number, radius: number, z: number): Tri[] {
  const center: Point = [0, 0, z];
  const tris: Tri[] = [];
  for (let i = 0; i < fn; i++) {
    const a0 = (i / fn) * TAU;
    const a1 = ((i + 1) / fn) * TAU;
    const p0: Point = [radius * Math.cos(a0), radius * Math.sin(a0), z];
    const p1: Point = [radius * Math.cos(a1), radius * Math.sin(a1), z];
    tris.push([center, p0, p1]);
  }
  return tris;
}

/** A flat annular collar at height `z`, from `innerRadius` to `outerRadius` -- simulates the flat top of a box a cylindrical boss is unioned into, sharing its inner edge with the boss's bottom ring. */
function flatCollar(fn: number, innerRadius: number, outerRadius: number, z: number): Tri[] {
  const tris: Tri[] = [];
  for (let i = 0; i < fn; i++) {
    const a0 = (i / fn) * TAU;
    const a1 = ((i + 1) / fn) * TAU;
    const inner0: Point = [innerRadius * Math.cos(a0), innerRadius * Math.sin(a0), z];
    const inner1: Point = [innerRadius * Math.cos(a1), innerRadius * Math.sin(a1), z];
    const outer0: Point = [outerRadius * Math.cos(a0), outerRadius * Math.sin(a0), z];
    const outer1: Point = [outerRadius * Math.cos(a1), outerRadius * Math.sin(a1), z];
    tris.push([inner0, outer1, outer0]);
    tris.push([inner0, inner1, outer1]);
  }
  return tris;
}

/** A cube of the given half-extent, 6 faces x 2 triangles, outward normals. */
function buildCube(half: number): Tri[] {
  const tris: Tri[] = [
    // +Z / -Z
    [[-half, -half, half], [half, -half, half], [half, half, half]],
    [[-half, -half, half], [half, half, half], [-half, half, half]],
    [[-half, -half, -half], [-half, half, -half], [half, half, -half]],
    [[-half, -half, -half], [half, half, -half], [half, -half, -half]],
    // +X / -X
    [[half, -half, -half], [half, half, -half], [half, half, half]],
    [[half, -half, -half], [half, half, half], [half, -half, half]],
    [[-half, -half, -half], [-half, -half, half], [-half, half, half]],
    [[-half, -half, -half], [-half, half, half], [-half, half, -half]],
    // +Y / -Y
    [[-half, half, -half], [-half, half, half], [half, half, half]],
    [[-half, half, -half], [half, half, half], [half, half, -half]],
    [[-half, -half, -half], [half, -half, -half], [half, -half, half]],
    [[-half, -half, -half], [half, -half, half], [-half, -half, half]]
  ];
  return tris;
}

/** A flat strip beveled 45° between X and Z (perpendicular to Y), tessellated into `steps` coplanar segments along Y. */
function chamferStrip(steps: number, stepLength: number): Tri[] {
  const tris: Tri[] = [];
  for (let i = 0; i < steps; i++) {
    const y0 = i * stepLength;
    const y1 = (i + 1) * stepLength;
    const p0: Point = [0, y0, 0];
    const p1: Point = [5, y0, 5];
    const p2: Point = [5, y1, 5];
    const p3: Point = [0, y1, 0];
    tris.push([p0, p1, p2]);
    tris.push([p0, p2, p3]);
  }
  return tris;
}

/** A cone's side wall (no base cap): apex at (0, 0, height), base circle of `baseRadius` at z = 0. */
function conePatch(fn: number, baseRadius: number, height: number): Tri[] {
  const apex: Point = [0, 0, height];
  const tris: Tri[] = [];
  for (let i = 0; i < fn; i++) {
    const a0 = (i / fn) * TAU;
    const a1 = ((i + 1) / fn) * TAU;
    const p0: Point = [baseRadius * Math.cos(a0), baseRadius * Math.sin(a0), 0];
    const p1: Point = [baseRadius * Math.cos(a1), baseRadius * Math.sin(a1), 0];
    tris.push([p0, p1, apex]);
  }
  return tris;
}

/** Extrudes a closed 2D outline (in order, wrapping) into a side wall between z0 and z1. */
function extrudeOutline(outline: readonly [number, number][], z0: number, z1: number): Tri[] {
  const tris: Tri[] = [];
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    const p0: Point = [x0, y0, z0];
    const p1: Point = [x1, y1, z0];
    const p2: Point = [x1, y1, z1];
    const p3: Point = [x0, y0, z1];
    tris.push([p0, p1, p2]);
    tris.push([p0, p2, p3]);
  }
  return tris;
}

/**
 * A stadium (two semicircular arcs joined by two straight tangent
 * flats) outline, extruded into a side wall between z0 and z1. The
 * flats are exactly tangent to the arcs, so the facet-step between an
 * arc's last facet and its adjoining flat is small -- growth crosses
 * onto the flats and joins the whole perimeter into one region.
 */
function stadiumWall(arcRadius: number, halfLength: number, arcStepDeg: number, z0: number, z1: number): Tri[] {
  const outline: [number, number][] = [];
  const rightSteps = Math.round(180 / arcStepDeg);
  for (let i = 0; i <= rightSteps; i++) {
    const deg = -90 + (i / rightSteps) * 180;
    const rad = (deg * Math.PI) / 180;
    outline.push([halfLength + arcRadius * Math.cos(rad), arcRadius * Math.sin(rad)]);
  }
  for (let i = 0; i <= rightSteps; i++) {
    const deg = 90 + (i / rightSteps) * 180;
    const rad = (deg * Math.PI) / 180;
    outline.push([-halfLength + arcRadius * Math.cos(rad), arcRadius * Math.sin(rad)]);
  }
  return extrudeOutline(outline, z0, z1);
}

/**
 * A box's side wall with equal 45° chamfers cut on all four vertical
 * edges -- an irregular octagon-like outline: each vertex-to-vertex
 * angular span alternates between a short chamfer and a long main
 * face, unlike a true regular octagon's uniform steps.
 */
function chamferedBoxWall(half: number, chamfer: number, z0: number, z1: number): Tri[] {
  const h = half;
  const c = chamfer;
  const outline: [number, number][] = [
    [h - c, h],
    [h, h - c],
    [h, -(h - c)],
    [h - c, -h],
    [-(h - c), -h],
    [-h, -(h - c)],
    [-h, h - c],
    [-(h - c), h]
  ];
  return extrudeOutline(outline, z0, z1);
}

/**
 * A near-complete ring (all but one facet) unioned with a flat box
 * face that shares only the vertical edge at angle 0 with the ring,
 * extending outward in a direction unrelated to the ring's local
 * radial or tangent direction there -- a realistic "cylinder meets a
 * flat box wall parallel to the axis" seam, at a seam angle well past
 * `maxFacetStepDeg`.
 */
function ringWithAxialBoxSeam(fn: number, radius: number, z0: number, z1: number): { tris: Tri[]; wallCount: number } {
  const wallTris = ringWall(fn, radius, z0, z1, { coveredFacets: fn - 1 });
  // The ring's own facet nearest this edge (facet 0, spanning angle 0
  // to 360/fn) has a radial normal near angle 0. Shifting the box
  // face's far edge to -Y gives it a normal near angle 180 -- a seam
  // of roughly 176°, comfortably past both maxFacetStepDeg (31°) and
  // the ticket's stated 60° floor.
  const v0z0: Point = [radius, 0, z0];
  const v0z1: Point = [radius, 0, z1];
  const far0: Point = [radius, -radius, z0];
  const far1: Point = [radius, -radius, z1];
  const boxTris: Tri[] = [
    [v0z0, far0, far1],
    [v0z0, far1, v0z1]
  ];
  return { tris: [...wallTris, ...boxTris], wallCount: wallTris.length };
}

function expectRecognized(outcome: ReturnType<typeof inspectSurface>) {
  expect(outcome.status).toBe("recognized");
  if (outcome.status !== "recognized") throw new Error("expected a recognized outcome");
  return outcome.inspection;
}

function expectRefused(outcome: ReturnType<typeof inspectSurface>) {
  expect(outcome.status).toBe("refused");
  if (outcome.status !== "refused") throw new Error("expected a refused outcome");
  return outcome.refusal;
}

describe("inspectSurface", () => {
  it("recognizes a 48-segment cylinder with the exact diameter", () => {
    const geometry = buildSTLLikeGeometry(ringWall(48, 20, 0, 15));
    const inspection = expectRecognized(inspectSurface(geometry, 0));
    expect(inspection.axis).toBe("z");
    expect(inspection.surface).toBe("outside");
    expect(inspection.diameterMm).toBeCloseTo(40, 3);
    expect(inspection.evidence.segments).toBe(48);
  });

  it("recognizes a coaxial outside surface and hole as two separate regions", () => {
    const outerTris = ringWall(48, 20, 0, 15, { orientation: "outward" });
    const holeTris = ringWall(48, 8, 0, 15, { orientation: "inward" });
    const geometry = buildSTLLikeGeometry([...outerTris, ...holeTris]);

    const outer = expectRecognized(inspectSurface(geometry, 0));
    expect(outer.surface).toBe("outside");
    expect(outer.diameterMm).toBeCloseTo(40, 3);

    const hole = expectRecognized(inspectSurface(geometry, outerTris.length));
    expect(hole.surface).toBe("hole");
    expect(hole.diameterMm).toBeCloseTo(16, 3);
  });

  it("refuses planar for a cube face", () => {
    const geometry = buildSTLLikeGeometry(buildCube(5));
    const refusal = expectRefused(inspectSurface(geometry, 0));
    expect(refusal.code).toBe("planar");
  });

  it("refuses planar for a 45° chamfer strip (a flat surface perpendicular to an axis)", () => {
    const geometry = buildSTLLikeGeometry(chamferStrip(5, 2));
    const outcome = inspectSurface(geometry, 0);
    // The seed's own normal is perpendicular to Y (not along any axis),
    // so this is caught by the post-growth normal-spread check, not the
    // immediate seed check -- growth must actually accumulate the whole
    // coplanar strip first.
    const refusal = expectRefused(outcome);
    expect(refusal.code).toBe("planar");
  });

  it("refuses too-coarse for a hex prism, whose 60° facet-to-facet step exceeds the growth threshold -- via the coarse-polygon probe, not the normal fit", () => {
    const geometry = buildSTLLikeGeometry(ringWall(6, 10, 0, 10));
    const refusal = expectRefused(inspectSurface(geometry, 0));
    expect(refusal.code).toBe("too-coarse");
    expect(refusal.message).toContain("only 6 segments");
  });

  it("refuses planar for a hex prism's own cap, whose normal is along the axis (not a coarse-polygon case at all)", () => {
    const fn = 6;
    const wall = ringWall(fn, 10, 0, 10);
    const cap = diskCap(fn, 10, 10);
    const geometry = buildSTLLikeGeometry([...wall, ...cap]);
    const refusal = expectRefused(inspectSurface(geometry, wall.length));
    expect(refusal.code).toBe("planar");
  });

  it("refuses too-coarse for a regular octagon (45° steps)", () => {
    const geometry = buildSTLLikeGeometry(ringWall(8, 10, 0, 10));
    const refusal = expectRefused(inspectSurface(geometry, 0));
    expect(refusal.code).toBe("too-coarse");
    expect(refusal.message).toContain("only 8 segments");
  });

  it("refuses too-coarse for a regular 11-gon", () => {
    const geometry = buildSTLLikeGeometry(ringWall(11, 10, 0, 10));
    const refusal = expectRefused(inspectSurface(geometry, 0));
    expect(refusal.code).toBe("too-coarse");
    expect(refusal.message).toContain("only 11 segments");
  });

  it("refuses planar for a box with four 45° vertical-edge chamfers, seeded on a chamfer -- an irregular polygon (alternating steps), not a coarse regular one", () => {
    const geometry = buildSTLLikeGeometry(chamferedBoxWall(10, 1, 0, 10));
    // Outline edge 0 is a chamfer (see chamferedBoxWall); its 2 triangles are indices 0-1.
    const refusal = expectRefused(inspectSurface(geometry, 0));
    expect(refusal.code).toBe("planar");
  });

  it("recognizes a cylinder unioned with a box face parallel to the axis, at a seam well past maxFacetStepDeg: the failing case the coarse-polygon probe must not misfire on", () => {
    const fn = 48;
    const radius = 20;
    const { tris, wallCount } = ringWithAxialBoxSeam(fn, radius, 0, 15);
    const geometry = buildSTLLikeGeometry(tris);

    // The seam is at least 60°, as the fixup requires -- facet 0 (the
    // ring facet sharing the box face's edge, at angle 0) vs. the box
    // face's own normal.
    const ringFacetNormal = faceNormalArr(...tris[0]);
    const boxFaceNormal = faceNormalArr(...tris[wallCount]);
    const dot = ringFacetNormal[0] * boxFaceNormal[0] + ringFacetNormal[1] * boxFaceNormal[1] + ringFacetNormal[2] * boxFaceNormal[2];
    const seamAngleDeg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    expect(seamAngleDeg).toBeGreaterThanOrEqual(60);

    // Seed away from the seam so growth has to walk toward it.
    const outcome = inspectSurface(geometry, Math.floor(wallCount / 2));
    const inspection = expectRecognized(outcome);
    expect(inspection.diameterMm).toBeCloseTo(radius * 2, 2);
    if (outcome.status === "recognized") {
      expect(outcome.regionTriangles.length).toBe(wallCount);
      for (const t of outcome.regionTriangles) expect(t).toBeLessThan(wallCount);
    }
  });

  it("refuses not-circular for a stadium slot: tangent flats join both arcs into one region that doesn't fit a circle", () => {
    const geometry = buildSTLLikeGeometry(stadiumWall(8, 15, 10, 0, 10));
    const refusal = expectRefused(inspectSurface(geometry, 0));
    expect(refusal.code).toBe("not-circular");
  });

  it("refuses not-axis-aligned for a cone", () => {
    const geometry = buildSTLLikeGeometry(conePatch(8, 10, 10));
    // Seed at a facet away from any axis-coincidental angle (facet 1,
    // centered at 67.5°) so no component is accidentally near zero.
    const refusal = expectRefused(inspectSurface(geometry, 1));
    expect(refusal.code).toBe("not-axis-aligned");
  });

  it("refuses partial-arc for a quarter-round (90° of a 48-segment ring, nothing beyond it)", () => {
    const geometry = buildSTLLikeGeometry(ringWall(48, 20, 0, 10, { coveredFacets: 12 }));
    const refusal = expectRefused(inspectSurface(geometry, 0));
    expect(refusal.code).toBe("partial-arc");
  });

  it("stops growth at end caps: a closed cylinder's region is only its side wall, never the caps", () => {
    const fn = 48;
    const wall = ringWall(fn, 20, 0, 15);
    const bottomCap = diskCap(fn, 20, 0);
    const topCap = diskCap(fn, 20, 15);
    const geometry = buildSTLLikeGeometry([...wall, ...bottomCap, ...topCap]);

    const outcome = inspectSurface(geometry, 0);
    const inspection = expectRecognized(outcome);
    expect(inspection.diameterMm).toBeCloseTo(40, 3);
    if (outcome.status === "recognized") {
      expect(outcome.regionTriangles.length).toBe(wall.length);
      for (const t of outcome.regionTriangles) expect(t).toBeLessThan(wall.length);
    }
  });

  it("stops growth at a boolean seam: a cylindrical boss unioned into a flat collar never absorbs the collar", () => {
    const fn = 48;
    const wall = ringWall(fn, 10, 0, 15);
    const collar = flatCollar(fn, 10, 25, 0);
    const geometry = buildSTLLikeGeometry([...wall, ...collar]);

    // Seed near the top of the wall, away from the seam, so growth has
    // to walk down toward the collar to test the stop.
    const outcome = inspectSurface(geometry, wall.length - 1);
    const inspection = expectRecognized(outcome);
    expect(inspection.diameterMm).toBeCloseTo(20, 3);
    if (outcome.status === "recognized") {
      expect(outcome.regionTriangles.length).toBe(wall.length);
      for (const t of outcome.regionTriangles) expect(t).toBeLessThan(wall.length);
    }
  });

  it("keeps displayed triangle order: regionTriangles index the original (unwelded) geometry, not a reordered welded one", () => {
    const fn = 12;
    const radius = 15;
    const tris = ringWall(fn, radius, 0, 10);
    const geometry = buildSTLLikeGeometry(tris);
    const outcome = inspectSurface(geometry, 5);
    const inspection = expectRecognized(outcome);
    if (outcome.status !== "recognized") return;

    expect(outcome.regionTriangles.length).toBe(tris.length);
    const positionAttr = geometry.getAttribute("position");
    for (const t of outcome.regionTriangles) {
      const cx = (positionAttr.getX(t * 3) + positionAttr.getX(t * 3 + 1) + positionAttr.getX(t * 3 + 2)) / 3;
      const cy = (positionAttr.getY(t * 3) + positionAttr.getY(t * 3 + 1) + positionAttr.getY(t * 3 + 2)) / 3;
      const distFromAxis = Math.hypot(cx - inspection.center.x, cy - inspection.center.y);
      // Each triangle's centroid sits strictly inside the true radius
      // (it's a chord, not the arc) but not by much, at fn = 12.
      expect(distFromAxis).toBeGreaterThan(radius * 0.8);
      expect(distFromAxis).toBeLessThanOrEqual(radius);
    }
  });

  it("caches the weld per geometry: a later call is served from the cache, not rebuilt from mutated data", () => {
    const geometry = buildSTLLikeGeometry(ringWall(48, 20, 0, 15));
    const first = inspectSurface(geometry, 0);

    const positionAttr = geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < positionAttr.count; i++) {
      positionAttr.setXYZ(i, positionAttr.getX(i) * 3, positionAttr.getY(i) * 3, positionAttr.getZ(i));
    }

    const second = inspectSurface(geometry, 0);
    expect(second).toEqual(first);
  });

  it("does not share the weld cache across different geometry instances", () => {
    const geometryA = buildSTLLikeGeometry(ringWall(48, 20, 0, 15));
    const geometryB = buildSTLLikeGeometry(ringWall(48, 6, 0, 15));

    const inspectionA = expectRecognized(inspectSurface(geometryA, 0));
    const inspectionB = expectRecognized(inspectSurface(geometryB, 0));

    expect(inspectionA.diameterMm).toBeCloseTo(40, 3);
    expect(inspectionB.diameterMm).toBeCloseTo(12, 3);
  });
});
