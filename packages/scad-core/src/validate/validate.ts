// @scadforge/scad-core — validate_mesh: manifold-3d mesh validation over a
// binary STL export (Spike 4's merged proposal). Reimplemented
// production-grade from Spike 4's `validate.mjs` reference
// (docs/spikes/04-manifold-validate); not imported from spikes/.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
// manifold-3d ships its own `manifold.d.ts`; no @types package needed.
import Module from "manifold-3d";
import type { ValidationReport, ValidationRequest, ValidationResult } from "../types.js";
import { ScadForgeError } from "../errors.js";
import { gateValidation } from "./gate.js";
import { weldTriangleSoup } from "./mesh-utils.js";
import { parseStl } from "./stl.js";

// `manifold-3d`'s WASM module is expensive to instantiate; it is loaded once
// and reused across calls in this process. (Unlike the WASM-in-worker preview
// path — M2's concern — there is no long-running-instance leak risk here:
// `packages/scad-core` runs server-side, one process, no per-render
// re-instantiation requirement.)
let modulePromise: ReturnType<typeof Module> | null = null;
async function getManifoldModule() {
  if (!modulePromise) {
    modulePromise = Module();
    const wasm = await modulePromise;
    wasm.setup();
  }
  return modulePromise;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Runs manifold-3d against a welded mesh and produces the frozen
 * `ValidationReport`. Construction failures (the mesh is not an oriented
 * 2-manifold at all) are caught, not rethrown — Spike 4's contract names that
 * case `status: 'ConstructionFailed'`, a legitimate (non-error) report value.
 */
async function buildReport(
  welded: ReturnType<typeof weldTriangleSoup>,
  wasm: Awaited<ReturnType<typeof Module>>
): Promise<ValidationReport> {
  const mesh = new wasm.Mesh({
    numProp: welded.numProp,
    vertProperties: welded.vertProperties,
    triVerts: welded.triVerts
  });

  let manifoldObj: InstanceType<typeof wasm.Manifold>;
  try {
    manifoldObj = new wasm.Manifold(mesh);
  } catch {
    // manifold-3d throws (rather than returning an errored handle) when the
    // welded topology is not an oriented 2-manifold. The contract's name for
    // this case is 'ConstructionFailed', not the library's raw thrown message.
    return {
      manifold: false,
      status: "ConstructionFailed",
      volume_mm3: null,
      surface_area: null,
      bbox: null,
      triangle_count: welded.rawTriangleCount,
      components: null,
      genus: null
    };
  }

  try {
    const status = manifoldObj.status();
    const isManifold = status === "NoError" && !manifoldObj.isEmpty();
    if (!isManifold) {
      return {
        manifold: false,
        status,
        volume_mm3: null,
        surface_area: null,
        bbox: null,
        triangle_count: welded.rawTriangleCount,
        components: null,
        genus: null
      };
    }

    const box = manifoldObj.boundingBox();
    const components = manifoldObj.decompose().length;
    return {
      manifold: true,
      status,
      volume_mm3: round(manifoldObj.volume()),
      surface_area: round(manifoldObj.surfaceArea()),
      bbox: {
        min: [round(box.min[0]), round(box.min[1]), round(box.min[2])],
        max: [round(box.max[0]), round(box.max[1]), round(box.max[2])]
      },
      triangle_count: manifoldObj.numTri(),
      components,
      genus: manifoldObj.genus()
    };
  } finally {
    manifoldObj.delete?.();
  }
}

/**
 * `validate_mesh` — loads the binary STL at `request.meshPath` (a parallel
 * export alongside the requested 3MF/OFF — see `runner/export.ts`), welds its
 * triangle soup, and validates it with manifold-3d. Returns the raw
 * {@link ValidationReport} plus the {@link ValidationGateResult} gate
 * decision.
 *
 * Never throws a bare Error: a missing file or unparseable mesh raises a
 * typed `ScadForgeError('MESH_PARSE_FAILED', ...)` (AC "Malformed/missing
 * mesh file → clean typed error, never an uncaught stack trace").
 */
export async function validateMesh(request: ValidationRequest): Promise<ValidationResult> {
  const start = process.hrtime.bigint();

  let buf: Buffer;
  try {
    buf = await readFile(request.meshPath);
  } catch (err) {
    throw new ScadForgeError("MESH_PARSE_FAILED", `mesh file not found or unreadable: ${request.meshPath}`, {
      cause: err
    });
  }

  const triangles = parseStl(buf); // throws ScadForgeError('MESH_PARSE_FAILED', ...) on malformed input
  const welded = weldTriangleSoup(triangles);

  const wasm = await getManifoldModule();
  const report = await buildReport(welded, wasm);
  const validate_ms = Number(process.hrtime.bigint() - start) / 1e6;

  const gate = gateValidation(report, request.options);

  return { report, gate, export_ms: null, validate_ms };
}
