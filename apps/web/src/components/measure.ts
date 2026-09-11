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

export interface DimensionLine {
  axis: Axis;
  /** Flat xyz segment pairs: main line first, then the two axis-aligned extension lines connecting it to the model's edges. */
  segments: number[];
  /** Midpoint of the main line, nudged outward — where the mm label sits. */
  labelPosition: [number, number, number];
  /** Face-to-face distance along this axis (the bounding-box extent). */
  sizeMm: number;
}

/**
 * Drafting-style dimension lines for the three bounding-box extents.
 *
 * Each line is offset outward from one box edge along exactly ONE other
 * axis, so the extension lines that connect it to the model stay
 * axis-aligned (diagonal extensions read as clutter in 3D):
 *
 * - X extent: offset -Y from the front-bottom edge
 * - Y extent: offset +X from the right-bottom edge
 * - Z extent: offset +Y from the back-right vertical edge
 */
export function dimensionLines(box: BBox): DimensionLine[] {
  const size = bboxSize(box);
  const diagonal = Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2);
  // A point-mesh (zero diagonal) still gets a usable, non-zero gap.
  const gap = Math.max(diagonal * 0.12, 1);

  const { min, max } = box;
  const lines: DimensionLine[] = [
    {
      axis: "x",
      segments: [
        min.x, min.y - gap, min.z, max.x, min.y - gap, min.z,
        min.x, min.y - gap, min.z, min.x, min.y, min.z,
        max.x, min.y - gap, min.z, max.x, min.y, min.z
      ],
      labelPosition: [(min.x + max.x) / 2, min.y - gap * 1.6, min.z],
      sizeMm: size.x
    },
    {
      axis: "y",
      segments: [
        max.x + gap, min.y, min.z, max.x + gap, max.y, min.z,
        max.x + gap, min.y, min.z, max.x, min.y, min.z,
        max.x + gap, max.y, min.z, max.x, max.y, min.z
      ],
      labelPosition: [max.x + gap * 1.6, (min.y + max.y) / 2, min.z],
      sizeMm: size.y
    },
    {
      axis: "z",
      segments: [
        max.x, max.y + gap, min.z, max.x, max.y + gap, max.z,
        max.x, max.y + gap, min.z, max.x, max.y, min.z,
        max.x, max.y + gap, max.z, max.x, max.y, max.z
      ],
      labelPosition: [max.x, max.y + gap * 1.6, (min.z + max.z) / 2],
      sizeMm: size.z
    }
  ];
  return lines;
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
