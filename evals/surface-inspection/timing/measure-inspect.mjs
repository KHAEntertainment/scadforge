#!/usr/bin/env node --experimental-strip-types
// S2-6 timing pass (Node, not a browser — the browser pass is the human
// walk). Renders every sample with the pinned OpenSCAD image, then times
// the REAL `inspectSurface` (apps/web/src/components/inspect/surfaceRegion.ts)
// against the scope's proposed budget: <=100ms first click (weld +
// adjacency + growth + fit), <=16ms after. A miss is reported as data —
// this script asserts nothing and must not be added to the vitest gate.
//
// Run: node --experimental-strip-types evals/surface-inspection/timing/measure-inspect.mjs
// (see README.md for why --experimental-strip-types and the loader below
// are both needed, and what Node version this was last run under.)

import { register } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

register("./ts-loader.mjs", import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const HINGE_SCAD = join(REPO_ROOT, "evals/surface-inspection/fixture/hinge.scad");
const CLAMP_SCAD = join(REPO_ROOT, "evals/scenario-a2/fixture/clamp.scad");
const F5_SCAD = join(__dirname, "F5-detail.scad");
const STRESS_SCAD = join(__dirname, "stress-plate.scad");
const OPENSCAD_IMAGE = "docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7";

const { BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } = await import(
  join(WEB_ROOT, "node_modules/three/build/three.module.js")
);
const { STLLoader } = await import(join(WEB_ROOT, "node_modules/three/examples/jsm/loaders/STLLoader.js"));
const { mergeVertices } = await import(join(WEB_ROOT, "node_modules/three/examples/jsm/utils/BufferGeometryUtils.js"));
const { inspectSurface } = await import(join(WEB_ROOT, "src/components/inspect/surfaceRegion.ts"));

/**
 * Rough weld-only timing, for the "split weld vs adjacency+growth+fit" the
 * ticket asks for on a miss. Not a measurement of `inspectSurface`'s own
 * weld step (that's internal to surfaceRegion.ts, not exported, and this
 * ticket doesn't touch that file) — a SEPARATE, equivalent weld computed
 * here on a freshly cloned geometry, using the exact same technique
 * surfaceRegion.ts's own `buildWeldedMesh` uses (position-only clone, then
 * `mergeVertices`). A reasonable proxy since it's the same library call on
 * the same data; "adjacency + growth + fit" is then inferred as the
 * remainder of the real first-call time.
 */
function timeWeldOnly(geometry) {
  return timeMs(() => {
    const positionOnly = new BufferGeometry();
    positionOnly.setAttribute("position", geometry.getAttribute("position").clone());
    mergeVertices(positionOnly);
  });
}

async function renderToStl(scadPath, params, workDir) {
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

function stlToGeometry(buf) {
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new STLLoader().parse(arrayBuffer);
}

function faceIndexForRay(geometry, ray) {
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  const raycaster = new Raycaster();
  raycaster.set(new Vector3(...ray.origin), new Vector3(...ray.direction).normalize());
  const hits = raycaster.intersectObject(mesh, false);
  const nearest = hits[0];
  if (!nearest || nearest.faceIndex == null) {
    throw new Error(`ray missed the mesh: origin=${JSON.stringify(ray.origin)} direction=${JSON.stringify(ray.direction)}`);
  }
  return nearest.faceIndex;
}

function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// F5 rays: no expected-results file exists for this fixture (S2-6 only
// needs timing, not correctness) -- picked directly from its own source
// (evals/surface-inspection/timing/F5-detail.scad: w=80, quality=96):
//   - 5 small holes (d=4, h=4, $fn=96) at x=10..50 step 10, y=25.
//   - 2 of the 4 rounded corners (r=4, h=30, $fn=96) the outer hull() forms
//     at (4,4), (76,4), (4,46), (76,46) -- picking the two on a diagonal.
//   - 2 flat points (the top face, and the backplate-like front face) to
//     exercise the immediate-planar-refusal path too.
// 37deg / 217deg-style off-cardinal angles throughout, matching the
// fixture rays' own rationale (avoids landing on a $fn=96 facet seam,
// 360/96 = 3.75deg per step; 37 and 217 are not multiples of 3.75).
// ---------------------------------------------------------------------------
function f5Rays() {
  const rad = (deg) => (deg * Math.PI) / 180;
  const rays = [];
  for (const x of [10, 20, 30, 40, 50]) {
    const cos = Math.cos(rad(37));
    const sin = Math.sin(rad(37));
    rays.push({ feature: `hole_x${x}`, origin: [x, 25, 1], direction: [cos, sin, 0] });
  }
  const corners = [
    { x: 4, y: 4, outAngle: 217 },
    { x: 76, y: 46, outAngle: 37 }
  ];
  for (const c of corners) {
    const cos = Math.cos(rad(c.outAngle));
    const sin = Math.sin(rad(c.outAngle));
    const origin = [c.x + 14 * cos, c.y + 14 * sin, 15];
    rays.push({ feature: `corner_${c.x}_${c.y}`, origin, direction: [-cos, -sin, 0] });
  }
  // Top of the raised perimeter wall (not the hollowed-out central base
  // slab a straight-down ray at mid-width would hit, and not aligned with
  // any of the 5 holes along y=25): x=40 is mid-length (away from the
  // rounded corners, so the y=0 edge is a plain straight wall there), at
  // y=1 -- inside the hull's own footprint but outside the inner cube's
  // y>=2 start, so the full z=0..30 wall height survives there.
  rays.push({ feature: "wall_top", origin: [40, 1, 40], direction: [0, 0, -1] });
  rays.push({ feature: "front_face", origin: [40, -10, 15], direction: [0, 1, 0] });
  return rays;
}

// ---------------------------------------------------------------------------
// stress-plate rays: same rationale as F5's (a stress mesh needs timing
// only, no expected-results file). Picked directly from stress-plate.scad's
// own grid formulas (plate_len=260, plate_wid=170, hole_margin=12,
// hole_cols=26, hole_rows=20, boss_cols=5, boss_rows=3, offset by half a
// hole pitch) — 3 holes (a corner, a middle one, a far one) plus 2 bosses,
// all at 37deg (not a multiple of the $fn=48 facet step, 7.5deg).
// ---------------------------------------------------------------------------
function stressPlateRays() {
  const rad = (deg) => (deg * Math.PI) / 180;
  const cos = Math.cos(rad(37));
  const sin = Math.sin(rad(37));

  const plateLen = 260;
  const plateWid = 170;
  const plateThick = 6;
  const holeMargin = 12;
  const holeCols = 26;
  const holeRows = 20;
  const holePitchX = (plateLen - 2 * holeMargin) / (holeCols - 1);
  const holePitchY = (plateWid - 2 * holeMargin) / (holeRows - 1);
  const bossCols = 5;
  const bossPitchX = (plateLen - 2 * holeMargin) / (bossCols - 1);
  const bossPitchY = (plateWid - 2 * holeMargin) / (3 - 1);
  const bossOffsetX = holePitchX / 2;
  const bossOffsetY = holePitchY / 2;

  const holeXY = (i, j) => [-plateLen / 2 + holeMargin + i * holePitchX, -plateWid / 2 + holeMargin + j * holePitchY];
  const bossXY = (i, j) => [-plateLen / 2 + holeMargin + bossOffsetX + i * bossPitchX, -plateWid / 2 + holeMargin + bossOffsetY + j * bossPitchY];

  const rays = [];
  const holeSpecs = [
    { name: "corner", ij: [0, 0] },
    { name: "mid", ij: [13, 10] },
    { name: "far", ij: [20, 5] }
  ];
  for (const spec of holeSpecs) {
    const [x, y] = holeXY(...spec.ij);
    rays.push({ feature: `hole_${spec.name}`, origin: [x, y, plateThick / 2], direction: [cos, sin, 0] });
  }
  const bossSpecs = [
    { name: "1", ij: [0, 0] },
    { name: "2", ij: [2, 1] }
  ];
  for (const spec of bossSpecs) {
    const [x, y] = bossXY(...spec.ij);
    const standoff = 15;
    rays.push({ feature: `boss_${spec.name}`, origin: [x + standoff * cos, y + standoff * sin, 10], direction: [-cos, -sin, 0] });
  }
  return rays;
}

async function loadExpectedRays(fixturePath) {
  const data = JSON.parse(await readFile(fixturePath, "utf8"));
  const bySample = {};
  for (const [sampleName, sample] of Object.entries(data.samples)) {
    bySample[sampleName] = { params: sample.params, rays: sample.rays.map((r) => ({ feature: r.feature, origin: r.ray.origin, direction: r.ray.direction })) };
  }
  return bySample;
}

// ---------------------------------------------------------------------------
async function measureSample(label, scadPath, params, rays, tmpRoot) {
  const workDir = join(tmpRoot, label.replace(/[^a-z0-9-]/gi, "_"));
  await mkdir(workDir, { recursive: true });
  const stlBuf = await renderToStl(scadPath, params, workDir);

  // Resolve each ray's triangle index once (same STL bytes -> same
  // triangle order every time they're re-parsed, so this is reused across
  // every fresh-geometry repetition below without re-raycasting under the
  // timer).
  const setupGeometry = stlToGeometry(stlBuf);
  const triangleCount = setupGeometry.getAttribute("position").count / 3;
  const faceIndices = rays.map((ray) => ({ feature: ray.feature, faceIndex: faceIndexForRay(setupGeometry, ray) }));
  const primary = faceIndices[0];

  // First-click timing: 5 independent cold starts, each a FRESH
  // BufferGeometry (inspectSurface's weld/adjacency cache is a WeakMap
  // keyed by the geometry object, so a new object is a genuine cold call).
  // Deliberately nothing else runs interleaved with this loop: an earlier
  // version of this script called timeWeldOnly() right before each rep and
  // it visibly (and wrongly) warmed the JIT for the real call — V8 doesn't
  // need to have run the SAME function before to benefit, running similar
  // BufferGeometry/typed-array code is enough. The weld-only split (below)
  // now runs strictly AFTER all 5 "clean" reps, only when needed.
  const firstCallMs = [];
  let warmGeometry = null;
  for (let i = 0; i < 5; i++) {
    const geometry = stlToGeometry(stlBuf);
    const ms = timeMs(() => inspectSurface(geometry, primary.faceIndex));
    firstCallMs.push(ms);
    if (i === 4) warmGeometry = geometry; // reuse the last (now warm) geometry below
  }

  // Subsequent-call timing: 20 more calls on that SAME (now warm) geometry,
  // cycling through every seed face for variety.
  const subsequentMs = [];
  for (let i = 0; i < 20; i++) {
    const target = faceIndices[i % faceIndices.length];
    const ms = timeMs(() => inspectSurface(warmGeometry, target.faceIndex));
    subsequentMs.push(ms);
  }

  // Weld-only split, run strictly AFTER the 5 clean first-call reps above
  // so it cannot warm the JIT for them. Still a rough, separately-computed
  // proxy (see timeWeldOnly) taken after other work has already run in
  // this process, so it is itself somewhat JIT-warmed relative to a true
  // cold start — reported as an approximate split, not a precise one.
  const weldOnlyMs = [];
  for (let i = 0; i < 5; i++) {
    weldOnlyMs.push(timeWeldOnly(stlToGeometry(stlBuf)));
  }

  await rm(workDir, { recursive: true, force: true });

  return {
    label,
    triangleCount,
    firstCallMedianMs: median(firstCallMs),
    firstCallMaxMs: Math.max(...firstCallMs),
    firstCallAllMs: firstCallMs,
    weldOnlyMedianMs: median(weldOnlyMs),
    weldOnlyAllMs: weldOnlyMs,
    subsequentMedianMs: median(subsequentMs),
    subsequentP95Ms: percentile(subsequentMs, 95)
  };
}

async function main() {
  const tmpRoot = await mkdtemp(join(tmpdir(), "scadforge-inspect-timing-"));
  const results = [];
  try {
    const hingeExpected = await loadExpectedRays(join(REPO_ROOT, "evals/surface-inspection/fixture/hinge.expected.json"));
    const clampExpected = await loadExpectedRays(join(REPO_ROOT, "evals/surface-inspection/fixture/clamp.expected.json"));

    for (const [sampleName, sample] of Object.entries(clampExpected)) {
      results.push(await measureSample(`clamp/${sampleName}`, CLAMP_SCAD, sample.params, sample.rays, tmpRoot));
    }
    for (const [sampleName, sample] of Object.entries(hingeExpected)) {
      results.push(await measureSample(`hinge/${sampleName}`, HINGE_SCAD, sample.params, sample.rays, tmpRoot));
    }
    results.push(await measureSample("F5-detail (default)", F5_SCAD, {}, f5Rays(), tmpRoot));
    results.push(await measureSample("stress-plate", STRESS_SCAD, {}, stressPlateRays(), tmpRoot));
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const FIRST_BUDGET_MS = 100;
  const SUBSEQUENT_BUDGET_MS = 16;

  console.log(`\nEnvironment: ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model ?? "unknown CPU"} x${os.cpus().length}`);
  console.log(`Node ${process.version}`);
  console.log("three: 0.169.0 (apps/web's pinned version)\n");

  console.log(
    "mesh".padEnd(22) +
      "triangles".padEnd(11) +
      "1st median".padEnd(12) +
      "1st max".padEnd(10) +
      "1st budget".padEnd(12) +
      "later median".padEnd(14) +
      "later p95".padEnd(11) +
      "later budget"
  );
  for (const r of results) {
    const firstPass = r.firstCallMaxMs <= FIRST_BUDGET_MS ? "PASS" : "MISS";
    const laterPass = r.subsequentP95Ms <= SUBSEQUENT_BUDGET_MS ? "PASS" : "MISS";
    console.log(
      r.label.padEnd(22) +
        String(r.triangleCount).padEnd(11) +
        r.firstCallMedianMs.toFixed(2).padEnd(12) +
        r.firstCallMaxMs.toFixed(2).padEnd(10) +
        firstPass.padEnd(12) +
        r.subsequentMedianMs.toFixed(2).padEnd(14) +
        r.subsequentP95Ms.toFixed(2).padEnd(11) +
        laterPass
    );
  }

  console.log("\nAll 5 first-call times per mesh (ms):");
  for (const r of results) {
    console.log(`  ${r.label}: ${r.firstCallAllMs.map((v) => v.toFixed(2)).join(", ")}`);
  }

  const missed = results.filter((r) => r.firstCallMaxMs > FIRST_BUDGET_MS);
  if (missed.length > 0) {
    console.log("\nRough weld-vs-rest split for first-click budget misses (weld measured independently, see timeWeldOnly; \"rest\" = adjacency + region growth + circle fit, inferred as the remainder):");
    for (const r of missed) {
      console.log(`  ${r.label}: weld median ${r.weldOnlyMedianMs.toFixed(2)}ms (all: ${r.weldOnlyAllMs.map((v) => v.toFixed(2)).join(", ")}); rest (median 1st call − weld median) ≈ ${(r.firstCallMedianMs - r.weldOnlyMedianMs).toFixed(2)}ms`);
    }
  }
}

await main();
