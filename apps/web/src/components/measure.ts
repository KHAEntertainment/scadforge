/**
 * Measurement overlay geometry (deferred measurement-visualization feature).
 *
 * Everything here is a pure function of a mesh bounding box so the whole
 * overlay is unit-testable without a WebGL context; the three.js rendering
 * in `DimensionOverlay.tsx` is a thin mapping over these results.
 *
 * Scope boundary (from the epic artifact): bounding-box dimensions plus a
 * selectable axis for face-to-face measurement. STL meshes carry triangles,
 * not semantic CAD faces, so "face-to-face" here means the two bounding-box
 * planes perpendicular to the chosen axis — honest, noise-free, and exactly
 * right for the bracket-style models this app produces. Automatic
 * per-feature dimensioning is deliberately out of scope.
 *
 * Hybrid display: each axis's measurement anchors to the bbox edge it
 * measures — the edge highlights, endpoint dots pin it to the model
 * corners, and the mm label hugs the edge midpoint. Focus mode adds
 * face-center dots plus a straight dashed connector through the part.
 *
 * Camera-aware edge pick (PR follow-up to #62): for each axis, label the
 * one of the four parallel bbox edges whose midpoint projects most
 * positively along the camera direction. Recomputed as the camera orbits
 * so the visible edge is always the labelled one — the failure mode the
 * static pick exhibited at oblique angles.
 */

export type Axis = "x" | "y" | "z";

export const AXES: readonly Axis[] = ["x", "y", "z"];

export interface BBoxPoint {
  x: number;
  y: number;
  z: number;
}

export interface BBox {
  min: BBoxPoint;
  max: BBoxPoint;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** True only for a finite, non-inverted box — a degenerate/empty mesh yields NaN or inverted bounds and must not produce NaN geometry. */
export function isValidBBox(box: BBox | null | undefined): box is BBox {
  if (!box) return false;
  const vals = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  return vals.every(Number.isFinite) && box.max.x >= box.min.x && box.max.y >= box.min.y && box.max.z >= box.min.z;
}

/** Per-axis extents in mm. */
export function bboxSize(box: BBox): Record<Axis, number> {
  return {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z
  };
}

/** Integer millimetres print bare ("105"); fractions keep one decimal ("12.5"). */
export function formatMm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/** A single bbox edge as a 3-tuple pair; coordinates are world-space mm. */
export type Edge = [[number, number, number], [number, number, number]];

export interface EdgeDimension {
  axis: Axis;
  /** The bbox edge being measured — coincides with real model geometry on bracket-style parts. */
  edge: Edge;
  /** Anchor dots at the edge endpoints pin the highlight to the model corners. */
  endpoints: Edge;
  /** Edge midpoint nudged slightly outward — the label hugs its edge. */
  labelPosition: [number, number, number];
  /** Face-to-face distance along this axis (the bounding-box extent). */
  sizeMm: number;
}

/** The four parallel bbox edges for a given axis — candidates for the camera-aware pick. */
export function parallelEdges(box: BBox, axis: Axis): Edge[] {
  const { min, max } = box;
  switch (axis) {
    case "x":
      // Edges running along X at the four (Y, Z) corner combinations.
      return [
        [[min.x, min.y, min.z], [max.x, min.y, min.z]],
        [[min.x, min.y, max.z], [max.x, min.y, max.z]],
        [[min.x, max.y, min.z], [max.x, max.y, min.z]],
        [[min.x, max.y, max.z], [max.x, max.y, max.z]]
      ];
    case "y":
      return [
        [[min.x, min.y, min.z], [min.x, max.y, min.z]],
        [[min.x, min.y, max.z], [min.x, max.y, max.z]],
        [[max.x, min.y, min.z], [max.x, max.y, min.z]],
        [[max.x, min.y, max.z], [max.x, max.y, max.z]]
      ];
    case "z":
      return [
        [[min.x, min.y, min.z], [min.x, min.y, max.z]],
        [[min.x, max.y, min.z], [min.x, max.y, max.z]],
        [[max.x, min.y, min.z], [max.x, min.y, max.z]],
        [[max.x, max.y, min.z], [max.x, max.y, max.z]]
      ];
  }
}

/** Midpoint of an edge in world space. */
export function edgeMidpoint(edge: Edge): [number, number, number] {
  return [
    (edge[0][0] + edge[1][0]) / 2,
    (edge[0][1] + edge[1][1]) / 2,
    (edge[0][2] + edge[1][2]) / 2
  ];
}

/**
 * Pick the edge of the four parallel bbox edges for `axis` whose midpoint
 * projects most positively along `cameraDirection` (the unit vector from
 * the bbox centre toward the camera). Ties broken by smallest squared
 * distance to that direction so the result is deterministic.
 *
 * Pure — the camera direction is a plain {x,y,z} so tests don't need a
 * three.js camera. Pass `null` (or a zero vector) to fall back to a
 * stable, axis-sensible default (front-bottom for X, right-bottom for Y,
 * back-right for Z — what the prototype shipped).
 */
export function selectCameraFacingEdge(box: BBox, axis: Axis, cameraDirection: Vec3 | null): Edge {
  const edges = parallelEdges(box, axis);
  const fallback = defaultEdge(box, axis);
  if (!cameraDirection) return fallback;

  const norm = Math.hypot(cameraDirection.x, cameraDirection.y, cameraDirection.z);
  if (!Number.isFinite(norm) || norm === 0) return fallback;

  const dx = cameraDirection.x / norm;
  const dy = cameraDirection.y / norm;
  const dz = cameraDirection.z / norm;

  let best = fallback;
  let bestScore = -Infinity;
  for (const edge of edges) {
    const [mx, my, mz] = edgeMidpoint(edge);
    const score = mx * dx + my * dy + mz * dz;
    if (score > bestScore) {
      bestScore = score;
      best = edge;
    }
  }
  return best;
}

/** The prototype's stable default pick when no camera direction is available. */
function defaultEdge(box: BBox, axis: Axis): Edge {
  const { min, max } = box;
  switch (axis) {
    case "x":
      return [[min.x, min.y, min.z], [max.x, min.y, min.z]];
    case "y":
      return [[max.x, min.y, min.z], [max.x, max.y, min.z]];
    case "z":
      return [[max.x, max.y, min.z], [max.x, max.y, max.z]];
  }
}

/**
 * Build the edge-anchored dimension description for a given axis. The
 * label position hugs the edge midpoint, nudged perpendicular to the
 * measured edge by a fraction of the bbox diagonal — large enough to
 * sit clearly outside the model (a small nudge can land the label on
 * the model's face and drei's occlusion test then hides it).
 *
 * `cameraDirection` is the unit vector from bbox centre toward the camera;
 * passing `null` selects the deterministic default edge.
 */
export function edgeDimension(box: BBox, axis: Axis, cameraDirection: Vec3 | null): EdgeDimension {
  const size = bboxSize(box);
  const diagonal = Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2);
  const nudge = Math.max(diagonal * 0.15, 1);

  const edge = selectCameraFacingEdge(box, axis, cameraDirection);
  const [m0, m1] = edge;
  const mid: [number, number, number] = [(m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2, (m0[2] + m1[2]) / 2];

  // The label sits perpendicular to the measured edge, pushed toward the
  // camera side. Using only the camera direction (no edge-along component)
  // guarantees the label clears the bbox on both free axes of the edge.
  const center = {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2
  };
  let outward: Vec3 = cameraDirection ?? defaultOutward(edge, mid, center);
  if (cameraDirection) {
    // Zero out the along-edge component so the label moves purely
    // perpendicular to the edge — that's the direction the model isn't
    // blocking.
    const alongAxisIndex = axisIndex(axis);
    outward = perpendicularAxis(outward, alongAxisIndex);
    // Re-magnitude so the nudge stays a constant geometric distance.
    outward = normalize(outward);
  }
  const labelPosition: [number, number, number] = [
    mid[0] + outward.x * nudge,
    mid[1] + outward.y * nudge,
    mid[2] + outward.z * nudge
  ];

  return { axis, edge, endpoints: edge, labelPosition, sizeMm: size[axis] };
}

/** Default outward direction when no camera is given: from the edge midpoint away from the bbox centre, in the plane perpendicular to the measured axis. */
function defaultOutward(edge: Edge, mid: [number, number, number], center: { x: number; y: number; z: number }): Vec3 {
  const dx = mid[0] - center.x;
  const dy = mid[1] - center.y;
  const dz = mid[2] - center.z;
  return normalize({ x: dx, y: dy, z: dz });
}

/** Zero out the component along the measured axis; keep the perpendicular components. */
function perpendicularAxis(v: Vec3, axis: 0 | 1 | 2): Vec3 {
  if (axis === 0) return { x: 0, y: v.y, z: v.z };
  if (axis === 1) return { x: v.x, y: 0, z: v.z };
  return { x: v.x, y: v.y, z: 0 };
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(n) || n === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function axisIndex(axis: Axis): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

/** A default outward direction per axis — the prototype's hand-picked nudge. */
function outwardAxisDefault(axis: Axis): Vec3 {
  switch (axis) {
    case "x":
      return { x: 0, y: -1, z: -1 };
    case "y":
      return { x: 1, y: 0, z: -1 };
    case "z":
      return { x: 1, y: 1, z: 0 };
  }
}

/** Build dimensions for all three axes in one call. Convenience for the overlay. */
export function edgeDimensions(box: BBox, cameraDirection: Vec3 | null): EdgeDimension[] {
  return AXES.map((axis) => edgeDimension(box, axis, cameraDirection));
}

/** The center points of the two face planes perpendicular to `axis` — connector endpoints for the focused face-to-face readout. */
export function faceCenters(box: BBox, axis: Axis): [[number, number, number], [number, number, number]] {
  const planes = facePlanes(box, axis);
  return [planes[0].position, planes[1].position];
}

/** The two face planes perpendicular to `axis` — the surfaces a face-to-face measurement spans. */
export function facePlanes(box: BBox, axis: Axis): { position: [number, number, number]; rotation: [number, number, number]; size: [number, number] }[] {
  const center = {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2
  };
  switch (axis) {
    case "x":
      // Plane perpendicular to X spans Y×Z; default three.js plane faces +Z, so rotate about Y.
      return [box.min.x, box.max.x].map((x) => ({
        position: [x, center.y, center.z],
        rotation: [0, Math.PI / 2, 0],
        size: [box.max.z - box.min.z, box.max.y - box.min.y]
      }));
    case "y":
      // Perpendicular to Y spans X×Z; rotate about X.
      return [box.min.y, box.max.y].map((y) => ({
        position: [center.x, y, center.z],
        rotation: [-Math.PI / 2, 0, 0],
        size: [box.max.x - box.min.x, box.max.z - box.min.z]
      }));
    case "z":
      // Perpendicular to Z spans X×Y; the default plane orientation already faces ±Z.
      return [box.min.z, box.max.z].map((z) => ({
        position: [center.x, center.y, z],
        rotation: [0, 0, 0],
        size: [box.max.x - box.min.x, box.max.y - box.min.y]
      }));
  }
}
