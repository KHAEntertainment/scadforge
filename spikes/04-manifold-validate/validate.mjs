#!/usr/bin/env node
// Spike 4 (#6): manifold-3d mesh validation CLI.
//
// Usage: node validate.mjs <mesh-file.(stl|3mf)>
//
// Prints a single JSON line:
//   {manifold, volume_mm3, surface_area, bbox, triangle_count, components, genus}
//
// Both STL and 3MF input are supported here (for side-by-side evaluation),
// but the PRODUCTION recommendation for validate_mesh is the parallel
// binary-STL export, not 3MF-parsing. See
// docs/spikes/04-manifold-validate/README.md's INPUT FORMAT DECISION for
// full rationale. Summary: manifold-3d needs indexed vertex/triangle
// topology either way; STL needs a zero-dependency vertex-weld step we
// already have, while 3MF needs a zip + XML parser (~2.2MB of extra deps,
// see lib/threemf.mjs). Color (3MF's advantage) is irrelevant to geometric
// validation. A single OpenSCAD invocation can emit `-o out.3mf -o out.stl`
// from one CGAL render, so there is no extra render cost to also requesting
// the parallel STL export.
import { readFileSync } from 'node:fs';
import Module from 'manifold-3d';
import { parseStl } from './lib/stl.mjs';
import { parse3mf } from './lib/threemf.mjs';
import { weldTriangleSoup } from './lib/mesh-utils.mjs';

function usageError(msg) {
  console.error(`Error: ${msg}`);
  console.error('Usage: node validate.mjs <mesh-file.(stl|3mf)>');
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) {
  usageError('missing <mesh-file> argument');
}

const ext = (inputPath.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
if (ext !== 'stl' && ext !== '3mf') {
  usageError(
    `unsupported extension '.${ext ?? ''}' for '${inputPath}'. Supported: .stl, .3mf.`,
  );
}

let buf;
try {
  buf = readFileSync(inputPath);
} catch (e) {
  usageError(`cannot read '${inputPath}': ${e.message}`);
}

const wasm = await Module();
wasm.setup();

function round(n, dp = 4) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function buildReport(welded) {
  const mesh = new wasm.Mesh({
    numProp: welded.numProp,
    vertProperties: welded.vertProperties,
    triVerts: welded.triVerts,
  });

  let manifoldObj;
  try {
    manifoldObj = new wasm.Manifold(mesh);
  } catch (e) {
    // manifold-3d throws (rather than returning an errored handle) when the
    // welded topology is not an oriented 2-manifold -- this is the direct
    // signal for the "open / non-manifold mesh" acceptance criterion.
    return {
      manifold: false,
      status: (e && e.message) || String(e),
      volume_mm3: null,
      surface_area: null,
      bbox: null,
      triangle_count: welded.rawTriangleCount,
      components: null,
      genus: null,
    };
  }

  const status = manifoldObj.status();
  const isManifold = status === 'NoError' && !manifoldObj.isEmpty();
  const box = manifoldObj.boundingBox();
  const components = manifoldObj.decompose().length;

  return {
    manifold: isManifold,
    status,
    volume_mm3: round(manifoldObj.volume()),
    surface_area: round(manifoldObj.surfaceArea()),
    bbox: {
      min: [round(box.min[0]), round(box.min[1]), round(box.min[2])],
      max: [round(box.max[0]), round(box.max[1]), round(box.max[2])],
    },
    triangle_count: manifoldObj.numTri(),
    components,
    genus: manifoldObj.genus(),
  };
}

let welded;
if (ext === 'stl') {
  const soup = parseStl(buf);
  welded = weldTriangleSoup(soup);
} else {
  // 3MF vertices/triangles are already indexed -- no welding needed.
  const parsed = await parse3mf(buf);
  welded = parsed;
}

const report = buildReport(welded);
console.log(JSON.stringify(report));
