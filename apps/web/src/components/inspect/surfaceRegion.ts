/**
 * Surface region growth and the `inspectSurface` entry point (S2 scope,
 * recognition method steps 2–4). The single seam every other S2 ticket
 * calls: from a clicked triangle on the displayed STL to a recognized
 * cylinder or a refusal.
 *
 * This is the only `inspect/` module allowed to import three.js — it's
 * the bridge from `BufferGeometry` to the pure region-growth/axis-selection
 * math, which now lives in `@scadforge/scad-core/geometry` (S3-B B5, Issue
 * #91: the pure S2 recognizer was ported into scad-core so the same code
 * backs both this click-driven Inspect entry and B5's server-side proof
 * service; see the S3-B ticket story's "Shared seams" and "Browser-safe
 * geometry entry").
 */

import { BufferGeometry } from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Triangle, Vec3, WeldedMesh } from "@scadforge/scad-core/geometry";
import { buildAdjacency, faceNormal, recognizeRegion } from "@scadforge/scad-core/geometry";
import type { InspectionOutcome } from "./inspectionTypes.js";

const weldCache = new WeakMap<BufferGeometry, WeldedMesh>();

/**
 * Weld a position-only clone of `geometry` and compute face normals from
 * the welded positions. Position-only because the STL loader attaches
 * per-face normals, and `mergeVertices` compares every attribute it
 * finds — with normals present it would never join two facets that
 * share a position but disagree on face normal, i.e. it would never
 * weld anything.
 *
 * Triangle order is preserved: `mergeVertices` walks the source
 * geometry's vertices in original order (0, 1, 2, …), so welded
 * triangle *i* is displayed triangle *i*.
 */
function buildWeldedMesh(geometry: BufferGeometry): WeldedMesh {
  const positionOnly = new BufferGeometry();
  positionOnly.setAttribute("position", geometry.getAttribute("position").clone());
  const sourceIndex = geometry.getIndex();
  if (sourceIndex) positionOnly.setIndex(sourceIndex.clone());

  const welded = mergeVertices(positionOnly);
  const weldedPositionAttr = welded.getAttribute("position");
  const weldedIndexAttr = welded.getIndex();
  if (!weldedIndexAttr) {
    throw new Error("surfaceRegion: mergeVertices did not produce an indexed geometry");
  }

  const positions: Vec3[] = [];
  for (let i = 0; i < weldedPositionAttr.count; i++) {
    positions.push({ x: weldedPositionAttr.getX(i), y: weldedPositionAttr.getY(i), z: weldedPositionAttr.getZ(i) });
  }

  const triangleCount = weldedIndexAttr.count / 3;
  const triangles: Triangle[] = [];
  const faceNormals: Vec3[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const a = weldedIndexAttr.getX(t * 3);
    const b = weldedIndexAttr.getX(t * 3 + 1);
    const c = weldedIndexAttr.getX(t * 3 + 2);
    triangles.push([a, b, c]);
    faceNormals.push(faceNormal(positions[a], positions[b], positions[c]));
  }

  const neighbors = buildAdjacency(triangles);
  positionOnly.dispose();
  welded.dispose();
  return { positions, triangles, faceNormals, neighbors };
}

function getWeldedMesh(geometry: BufferGeometry): WeldedMesh {
  const cached = weldCache.get(geometry);
  if (cached) return cached;
  const built = buildWeldedMesh(geometry);
  weldCache.set(geometry, built);
  const release = () => {
    weldCache.delete(geometry);
    geometry.removeEventListener("dispose", release);
  };
  geometry.addEventListener("dispose", release);
  return built;
}

/**
 * From a clicked triangle on the displayed STL geometry, to a
 * recognized cylinder or a refusal. Synchronous and pure with respect
 * to its inputs; the only state is the weld/adjacency cache, built
 * lazily per `geometry` and dropped with it (`WeakMap`). Axis selection,
 * region growth, the coarse-polygon-or-planar probe and circle fitting all
 * live in `@scadforge/scad-core/geometry`'s `recognizeRegion` now — this
 * function is purely the three.js → `WeldedMesh` bridge.
 */
export function inspectSurface(geometry: BufferGeometry, triangleIndex: number): InspectionOutcome {
  const mesh = getWeldedMesh(geometry);
  return recognizeRegion(mesh, triangleIndex);
}
