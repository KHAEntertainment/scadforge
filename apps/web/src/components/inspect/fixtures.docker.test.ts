// SPDX-License-Identifier: Apache-2.0
//
// @docker — S2-3 fixture tests. Renders every sample of both fixtures
// (evals/surface-inspection/fixture/{hinge,clamp}.scad) with the pinned
// OpenSCAD image, raycasts the known points recorded in
// evals/surface-inspection/fixture/{hinge,clamp}.expected.json against the
// real STL (three's STLLoader + Raycaster — no WebGL, no browser), and
// asserts `inspectSurface`'s outcome against those closed-form values.
//
// `apps/web` has no dependency on `@scadforge/scad-core` (and this ticket
// must not add one), so rendering goes straight through the `docker` CLI
// with the pinned digest, and "one connected component" is checked with a
// small local union-find over welded vertices rather than the real
// manifold-3d gate — a structural stand-in for the true validation gate,
// which already ran (via `validateModel()`) when
// evals/surface-inspection/README.md's numbers were produced.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { inspectSurface } from "./surfaceRegion.js";
import { notAxisAlignedRefusal, notCircularRefusal, partialArcRefusal, planarRefusal, tooCoarseRefusal } from "./refusals.js";
import type { InspectionOutcome, Refusal, RefusalCode } from "./inspectionTypes.js";

const OPENSCAD_IMAGE = "docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7";

function dockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/web/src/components/inspect -> repo root
const REPO_ROOT = join(__dirname, "../../../../..");
const HINGE_SCAD = join(REPO_ROOT, "evals/surface-inspection/fixture/hinge.scad");
const CLAMP_SCAD = join(REPO_ROOT, "evals/scenario-a2/fixture/clamp.scad");

interface RayDef {
  origin: readonly [number, number, number];
  direction: readonly [number, number, number];
}

interface ExpectedRecognized {
  status: "recognized";
  surface: "hole" | "outside";
  axis: "x" | "y" | "z";
  diameterMm: number;
  center: readonly [number, number, number];
}

interface ExpectedRefused {
  status: "refused";
  code: RefusalCode;
  message?: string;
}

interface ExpectedRow {
  feature: string;
  description?: string;
  ray: RayDef;
  expected: ExpectedRecognized | ExpectedRefused;
}

interface FixtureSample {
  params: Record<string, number>;
  meshValidation: { components: number; volume_mm3: number; bbox: unknown; genus: number };
  rays: ExpectedRow[];
}

interface FixtureExpected {
  fixture: string;
  toleranceMm: number;
  samples: Record<string, FixtureSample>;
}

// Loaded synchronously (module scope, before any describe/it body runs) so
// the full row list is available to generate one `it()` per row at
// collection time — this needs no docker daemon and always runs, even when
// the @docker suite below is skipped.
const hingeExpected: FixtureExpected = JSON.parse(
  await readFile(join(REPO_ROOT, "evals/surface-inspection/fixture/hinge.expected.json"), "utf8")
);
const clampExpected: FixtureExpected = JSON.parse(
  await readFile(join(REPO_ROOT, "evals/surface-inspection/fixture/clamp.expected.json"), "utf8")
);
const TOLERANCE_MM = hingeExpected.toleranceMm; // 0.01, same value in both files

/**
 * Renders `scadPath` with `params` as `-D key=value` overrides via the
 * pinned OpenSCAD image, matching `packages/scad-core/src/runner/mesh-export.ts`'s
 * own flags for an stl export (`--backend=Manifold --render=true
 * --colorscheme=Cornfield --export-format=binstl`), into a fresh binary STL
 * under `workDir` (a temp directory — nothing is written under evals/).
 */
async function renderToStl(scadPath: string, params: Record<string, number>, workDir: string): Promise<Buffer> {
  const modelFile = basename(scadPath);
  await copyFile(scadPath, join(workDir, modelFile));
  const defineArgs = Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`]);
  const outFile = "out.stl";
  const args = [
    "run",
    "--rm",
    "-v",
    `${workDir}:/work`,
    "-w",
    "/work",
    OPENSCAD_IMAGE,
    "openscad",
    "-o",
    `/work/${outFile}`,
    "--export-format=binstl",
    "--backend=Manifold",
    "--render=true",
    "--colorscheme=Cornfield",
    ...defineArgs,
    `/work/${modelFile}`
  ];
  execFileSync("docker", args, { timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  return readFile(join(workDir, outFile));
}

/** Binary STL bytes -> a raw, non-indexed, position-only BufferGeometry — exactly what STLLoader.parse() returns, no post-processing. */
function stlToGeometry(buf: Buffer): BufferGeometry {
  // Buffer.buffer is typed ArrayBufferLike (ArrayBuffer | SharedArrayBuffer)
  // because Buffer extends Uint8Array; a Buffer from node:fs/promises's
  // readFile is always backed by a plain ArrayBuffer.
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new STLLoader().parse(arrayBuffer);
}

/**
 * Connected-component count via a plain union-find over welded vertices —
 * a dependency-free stand-in for manifold-3d's `decompose().length` (not
 * available here; apps/web has no `@scadforge/scad-core` dependency and this
 * ticket must not add one). Sufficient for "is this one fused solid",
 * which is all the S2-3 acceptance criterion needs.
 */
function countConnectedComponents(geometry: BufferGeometry): number {
  const positionOnly = new BufferGeometry();
  positionOnly.setAttribute("position", geometry.getAttribute("position").clone());
  const welded = mergeVertices(positionOnly);
  const index = welded.getIndex();
  if (!index) throw new Error("countConnectedComponents: mergeVertices did not produce an indexed geometry");

  const vertexCount = welded.getAttribute("position").count;
  const parent = Array.from({ length: vertexCount }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const triCount = index.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    union(a, b);
    union(b, c);
  }

  const roots = new Set<number>();
  for (let t = 0; t < triCount; t++) {
    roots.add(find(index.getX(t * 3)));
  }
  return roots.size;
}

/** Raycasts (origin, direction) against `geometry` — DoubleSide, so winding never silently swallows a hit — and feeds the nearest hit's triangle into `inspectSurface`. */
function castAndInspect(geometry: BufferGeometry, ray: RayDef): InspectionOutcome {
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  const raycaster = new Raycaster();
  raycaster.set(new Vector3(...ray.origin), new Vector3(...ray.direction).normalize());
  const hits = raycaster.intersectObject(mesh, false);
  const nearest = hits[0];
  if (!nearest || nearest.faceIndex == null) {
    throw new Error(`ray missed the mesh entirely: origin=${JSON.stringify(ray.origin)} direction=${JSON.stringify(ray.direction)}`);
  }
  return inspectSurface(geometry, nearest.faceIndex);
}

/**
 * Reconstructs the expected message from `refusals.ts`'s own builders
 * (per the coordinator's note) rather than a literal string, for the three
 * codes with a filled-in placeholder — pulling the placeholder's actual
 * value out of the real message first, since it isn't otherwise predictable
 * in closed form.
 */
function assertRefusalMessage(refusal: Refusal): void {
  switch (refusal.code) {
    case "planar":
      expect(refusal.message).toBe(planarRefusal().message);
      return;
    case "not-axis-aligned":
      expect(refusal.message).toBe(notAxisAlignedRefusal().message);
      return;
    case "too-coarse": {
      const match = /only (\d+(?:\.\d+)?) segments/.exec(refusal.message);
      expect(match, `too-coarse message should name a segment count: ${refusal.message}`).not.toBeNull();
      expect(refusal.message).toBe(tooCoarseRefusal(Number(match![1])).message);
      return;
    }
    case "not-circular": {
      const match = /off by up to ([\d.]+) mm/.exec(refusal.message);
      expect(match, `not-circular message should name a deviation: ${refusal.message}`).not.toBeNull();
      expect(refusal.message).toBe(notCircularRefusal(Number(match![1])).message);
      return;
    }
    case "partial-arc": {
      const match = /Only (\d+(?:\.\d+)?)° of this curve/.exec(refusal.message);
      expect(match, `partial-arc message should name an arc coverage: ${refusal.message}`).not.toBeNull();
      expect(refusal.message).toBe(partialArcRefusal(Number(match![1])).message);
      return;
    }
  }
}

function assertOutcome(outcome: InspectionOutcome, expected: ExpectedRow["expected"]): void {
  expect(outcome.status, `full actual outcome: ${JSON.stringify(outcome, (_key, value) => (value instanceof Uint32Array ? Array.from(value) : value))}`).toBe(
    expected.status
  );
  if (expected.status === "recognized") {
    if (outcome.status !== "recognized") return; // already failed above
    expect(outcome.inspection.surface).toBe(expected.surface);
    expect(outcome.inspection.axis).toBe(expected.axis);
    expect(Math.abs(outcome.inspection.diameterMm - expected.diameterMm), `diameterMm: expected ${expected.diameterMm}, got ${outcome.inspection.diameterMm}`).toBeLessThanOrEqual(
      TOLERANCE_MM
    );
    const c = outcome.inspection.center;
    const [ex, ey, ez] = expected.center;
    expect(Math.abs(c.x - ex), `center.x: expected ${ex}, got ${c.x}`).toBeLessThanOrEqual(TOLERANCE_MM);
    expect(Math.abs(c.y - ey), `center.y: expected ${ey}, got ${c.y}`).toBeLessThanOrEqual(TOLERANCE_MM);
    expect(Math.abs(c.z - ez), `center.z: expected ${ez}, got ${c.z}`).toBeLessThanOrEqual(TOLERANCE_MM);
  } else {
    if (outcome.status !== "refused") return; // already failed above
    expect(outcome.refusal.code).toBe(expected.code);
    if (outcome.refusal.code === expected.code) assertRefusalMessage(outcome.refusal);
  }
}

describe.skipIf(!dockerAvailable())("@docker S2-3 fixture inspection (clamp + hinge)", () => {
  let tmpRoot: string;
  const geometries = new Map<string, BufferGeometry>();

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "scadforge-inspect-fixtures-"));
    for (const [sampleName, sample] of Object.entries(hingeExpected.samples)) {
      const workDir = join(tmpRoot, `hinge-${sampleName}`);
      await mkdir(workDir, { recursive: true });
      const stl = await renderToStl(HINGE_SCAD, sample.params, workDir);
      geometries.set(`hinge:${sampleName}`, stlToGeometry(stl));
    }
    for (const [sampleName, sample] of Object.entries(clampExpected.samples)) {
      const workDir = join(tmpRoot, `clamp-${sampleName}`);
      await mkdir(workDir, { recursive: true });
      const stl = await renderToStl(CLAMP_SCAD, sample.params, workDir);
      geometries.set(`clamp:${sampleName}`, stlToGeometry(stl));
    }
  }, 10 * 60_000);

  afterAll(async () => {
    for (const geometry of geometries.values()) geometry.dispose();
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  it.each([0.02, 0.05, -0.05])("refuses every real-STL triangle of a shallow frustum (radius delta %s)", async (delta) => {
    const source = join(tmpRoot, "frustum.scad");
    await writeFile(source, "cylinder(h=10, r1=20+delta, r2=20, $fn=48);");
    const workDir = join(tmpRoot, `frustum-${delta}`);
    await mkdir(workDir);
    const geometry = stlToGeometry(await renderToStl(source, { delta }, workDir));
    try {
      let walls = 0;
      for (let face = 0; face < geometry.getAttribute("position").count / 3; face++) {
        const outcome = inspectSurface(geometry, face);
        expect(outcome.status).toBe("refused");
        if (outcome.status === "refused" && outcome.refusal.code !== "planar") walls++;
      }
      expect(walls).toBe(96);
    } finally {
      geometry.dispose();
    }
  }, 120_000);

  describe("hinge", () => {
    for (const [sampleName, sample] of Object.entries(hingeExpected.samples)) {
      describe(sampleName, () => {
        it("renders as one connected piece", () => {
          const geometry = geometries.get(`hinge:${sampleName}`)!;
          expect(countConnectedComponents(geometry)).toBe(1);
        });

        for (const row of sample.rays) {
          it(row.feature, () => {
            const geometry = geometries.get(`hinge:${sampleName}`)!;
            const outcome = castAndInspect(geometry, row.ray);
            assertOutcome(outcome, row.expected);
          });
        }
      });
    }
  });

  describe("clamp", () => {
    for (const [sampleName, sample] of Object.entries(clampExpected.samples)) {
      describe(sampleName, () => {
        it("renders as one connected piece", () => {
          const geometry = geometries.get(`clamp:${sampleName}`)!;
          expect(countConnectedComponents(geometry)).toBe(1);
        });

        for (const row of sample.rays) {
          it(row.feature, () => {
            const geometry = geometries.get(`clamp:${sampleName}`)!;
            const outcome = castAndInspect(geometry, row.ray);
            assertOutcome(outcome, row.expected);
          });
        }
      });
    }
  });
});
