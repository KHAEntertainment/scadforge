#!/usr/bin/env node
// ScadForge Spike 2 — Node harness driving the pinned OpenSCAD image.
//
// Usage:
//   node run-views.mjs <model.scad> [outDir]
//
// Produces iso/front/top/right/section PNGs (1024x768), a colored 3MF,
// a --export-format=param JSON dump, and prints per-view timings.
// Every docker invocation passes args as an ARRAY (no shell interpolation)
// and is wrapped in a 60s timeout, per SDP §7 / Issue #4 architecture note.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGE = process.env.SCADFORGE_OPENSCAD_IMAGE ?? "scadforge-openscad:pinned";
const TIMEOUT_MS = 60_000;

// ---- FROZEN CONSTANTS (candidates for packages/agent/src/tools/contract.ts) ----
// Gimbal camera string: translate_x,y,z,rot_x,y,z,dist
// translate and dist are recomputed by --autocenter/--viewall; rot_x/y/z are
// the load-bearing fixed values that define each named view.
export const CAMERA = {
  iso:     { rot: [55, 0, 25] },
  front:   { rot: [90, 0, 0] },
  top:     { rot: [0, 0, 0] },
  right:   { rot: [90, 0, 90] },
  section: { rot: [90, 0, 0] }, // same as front; the cut comes from the wrapper .scad
};
export const COLORSCHEME = "Cornfield";
export const PROJECTION = "ortho";
export const IMG_SIZE = [1024, 768];
export const RENDER_FLAGS = ["--backend=Manifold", "--render", `--colorscheme=${COLORSCHEME}`];

function cameraArg(view) {
  const [rx, ry, rz] = CAMERA[view].rot;
  return `--camera=0,0,0,${rx},${ry},${rz},0`;
}

function baseArgs(view) {
  return [
    cameraArg(view),
    "--viewall",
    "--autocenter",
    `--projection=${PROJECTION}`,
    `--imgsize=${IMG_SIZE[0]},${IMG_SIZE[1]}`,
    ...RENDER_FLAGS,
  ];
}

/** Run the pinned OpenSCAD image with args as an array; no shell. */
function runDocker(args, { cwd, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const dockerArgs = [
      "run", "--rm",
      "-v", `${cwd}:/work`,
      "-w", "/work",
      IMAGE,
      ...args,
    ];
    const start = process.hrtime.bigint();
    const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`openscad timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (code !== 0) {
        reject(new Error(`openscad exited ${code}\nargs: ${args.join(" ")}\nstderr: ${stderr}`));
        return;
      }
      resolvePromise({ stdout, stderr, ms });
    });
  });
}

// NOTE on the section wrapper (verified during this spike, see README):
// The issue's suggested literal pattern
//   difference(){ include <model.scad>; <half-space cube> }
// does NOT parse. OpenSCAD's grammar rejects `include <...>` anywhere except
// a file's top level -- not inside a difference(){}, not inside a module{}
// body. (Verified: "ERROR: Parser error: syntax error in file
// libs/BOSL2/version.scad, line 36" / ".../color.scad, line 17" -- the
// parser fails deep inside whatever BOSL2 file the nested include pulls in,
// which is a confusing error to debug if you don't already suspect the
// include-nesting rule.)
//
// Working equivalent, and what real render pipelines do for an arbitrary
// post-hoc section cut regardless of how the source .scad is structured
// (single root module vs. bare top-level statements, our sample.scad's
// case): render the model to a mesh first, then `import()` + `difference()`
// that mesh with the half-space cube in a second, tiny wrapper file.
function sectionCutWrapper(meshRelPath) {
  // Removes the -Y half, exposing the Y=0 cross-section (wall thickness,
  // slot profile) toward the "front" camera direction (rot=90,0,0 looks
  // along -Y from the -Y side, so the retained +Y half's newly-cut face,
  // whose normal points -Y, faces the camera). Verified empirically: cutting
  // the +Y half instead leaves the *exterior* facing the front camera and
  // the render is visually indistinguishable from an uncut front view.
  return `difference() {\n  import("${meshRelPath}");\n  translate([-1000, -2000, -1000]) cube([2000, 2000, 2000]);\n}\n`;
}

async function renderPng(view, scadPath, cwd, outDir) {
  const outRel = `views/${view}.png`;
  await mkdir(join(cwd, "views"), { recursive: true });
  const args = ["-o", `/work/${outRel}`, ...baseArgs(view), `/work/${basename(scadPath)}`];
  const { ms, stderr } = await runDocker(args, { cwd });
  return { view, ms, stderr, outRel };
}

async function main() {
  const [, , modelArgPath, outDirArg] = process.argv;
  if (!modelArgPath) {
    console.error("Usage: node run-views.mjs <model.scad> [outDir]");
    process.exit(1);
  }
  const modelPath = resolve(modelArgPath);
  const modelDir = dirname(modelPath);
  const modelName = basename(modelPath);
  const outDir = resolve(outDirArg ?? join(__dirname, "out"));
  await mkdir(outDir, { recursive: true });

  // Stage a work dir containing the model + any local includes (libs/).
  const work = await mkdtemp(join(tmpdir(), "scadforge-spike2-"));
  await copyRecursive(modelDir, work);

  const timings = {};

  console.log(`[run-views] model=${modelName} image=${IMAGE} workdir=${work}`);

  // 1. Four fixed-camera views.
  for (const view of ["iso", "front", "top", "right"]) {
    const { ms, stderr } = await renderPng(view, modelName, work, outDir);
    timings[view] = ms;
    console.log(`[run-views] ${view}: ${ms.toFixed(1)}ms`);
    if (stderr.trim()) console.log(`  stderr: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }

  // 2. Section view: two-pass render. `difference(){ include <model.scad>; ... }`
  // does not parse (OpenSCAD rejects `include` inside any nested block --
  // verified, see README). Working equivalent: export the model to a mesh,
  // then import() + difference() that mesh with the half-space cube.
  const meshName = `__section_mesh_${modelName.replace(/\.scad$/, "")}.off`;
  {
    const args = ["-o", `/work/${meshName}`, ...RENDER_FLAGS, `/work/${modelName}`];
    const { ms } = await runDocker(args, { cwd: work });
    timings.sectionMeshExport = ms;
    console.log(`[run-views] section mesh export: ${ms.toFixed(1)}ms`);
  }
  const wrapperName = `__section_${modelName}`;
  await writeFile(join(work, wrapperName), sectionCutWrapper(meshName));
  {
    const args = [
      "-o", "/work/views/section.png",
      ...baseArgs("section"),
      `/work/${wrapperName}`,
    ];
    const { ms, stderr } = await runDocker(args, { cwd: work });
    timings.section = ms;
    console.log(`[run-views] section: ${ms.toFixed(1)}ms`);
    if (stderr.trim()) console.log(`  stderr: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }

  // 3. Determinism check: re-render "iso" and diff bytes.
  {
    await mkdir(join(work, "determinism"), { recursive: true });
    const args1 = ["-o", "/work/determinism/iso_a.png", ...baseArgs("iso"), `/work/${modelName}`];
    const args2 = ["-o", "/work/determinism/iso_b.png", ...baseArgs("iso"), `/work/${modelName}`];
    const r1 = await runDocker(args1, { cwd: work });
    const r2 = await runDocker(args2, { cwd: work });
    const bufA = await readFile(join(work, "determinism/iso_a.png"));
    const bufB = await readFile(join(work, "determinism/iso_b.png"));
    const identical = Buffer.compare(bufA, bufB) === 0;
    console.log(`[run-views] determinism (iso x2): identical=${identical} (run1=${r1.ms.toFixed(1)}ms run2=${r2.ms.toFixed(1)}ms)`);
    await copyFile(join(work, "determinism/iso_a.png"), join(outDir, "determinism_iso_a.png"));
    await copyFile(join(work, "determinism/iso_b.png"), join(outDir, "determinism_iso_b.png"));
    timings.determinism = { identical, run1Ms: r1.ms, run2Ms: r2.ms };
  }

  // 4. 3MF export.
  {
    const args = ["-o", "/work/model.3mf", ...RENDER_FLAGS, `/work/${modelName}`];
    const { ms } = await runDocker(args, { cwd: work });
    timings["3mf"] = ms;
    console.log(`[run-views] 3mf export: ${ms.toFixed(1)}ms`);
    await copyFile(join(work, "model.3mf"), join(outDir, "model.3mf"));
  }

  // 5. Param export.
  {
    const args = ["-o", "/work/model.param.json", "--export-format=param", `/work/${modelName}`];
    const { ms } = await runDocker(args, { cwd: work });
    timings.param = ms;
    console.log(`[run-views] param export: ${ms.toFixed(1)}ms`);
    await copyFile(join(work, "model.param.json"), join(outDir, "model.param.json"));
  }

  // Copy PNGs out.
  for (const view of ["iso", "front", "top", "right", "section"]) {
    await copyFile(join(work, "views", `${view}.png`), join(outDir, `${view}.png`));
  }

  await writeFile(join(outDir, "timings.json"), JSON.stringify(timings, null, 2));
  console.log(`[run-views] done. outputs in ${outDir}`);
  console.log(JSON.stringify(timings, null, 2));

  await rm(work, { recursive: true, force: true });
}

async function copyRecursive(src, dst) {
  const { cp } = await import("node:fs/promises");
  await cp(src, dst, { recursive: true });
}

main().catch((err) => {
  console.error("[run-views] FAILED:", err.message);
  process.exit(1);
});
