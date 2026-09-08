// GPL ZONE — Issue #31 / Issue #35.
//
// A Node-side CLI that drives the SAME openscad-wasm artifact the browser
// preview worker drives, so an automated harness can measure the mesh the
// preview produces without a browser in the loop.
//
// WHY THIS FILE LIVES HERE. PROJECT_CONTEXT.md's License section confines
// GPL-derived code (openscad-wasm glue) to `apps/web/src/wasm/**` only, so
// nothing outside that directory may reference the openscad-wasm binaries.
// `evals/scenario-a2/run.mjs` therefore never imports this module — it SPAWNS
// it as a child process, which keeps the GPL zone a process boundary as well
// as a directory boundary (and, incidentally, enforces the
// fresh-instance-per-render rule for free).
//
// WHAT IS AND IS NOT SHARED WITH THE BROWSER PREVIEW (Issue #35 fidelity
// note — read this before trusting a number this file produced):
//   SHARED   the exact `apps/web/public/wasm/openscad.js` + `openscad.wasm`
//            bytes the worker loads; `paramsToDefineArgs` imported from
//            `./protocol.ts` — the very function `openscad.worker.ts` calls,
//            not a reimplementation; the same argv shape
//            (`-o /out.stl --export-format=binstl --backend=manifold` + the
//            same `-D` overrides); the same `/libraries/BOSL2` staging; one
//            fresh module instance per process.
//   DIFFERS  the host. The worker runs in a DedicatedWorkerGlobalScope and
//            lets Emscripten `fetch()` the .wasm; Node has no such fetch for
//            a `file:` URL, so this file passes `wasmBinary` directly. That
//            changes how the module BYTES ARE OBTAINED, not which bytes, and
//            not a single argument the compiled program sees.
// This file is a NODE-ONLY proof, not browser evidence. It lets a harness
// measure the mesh the same openscad-wasm bytes + `-D`/argv produce, but it
// does not run inside a real page and makes no claim of browser numeric
// agreement. The real-browser load/preview check is a separate manual
// exercise owned by the project lead — see `evals/scenario-a2/README.md` for
// the Node-vs-browser boundary and exactly what each side covers.
//
// Usage:
//   node nodeWasmRender.mjs <model.scad> <out.stl> [paramsJson] [--meta meta.json]
//
// Exits 0 on a successful render; 1 with OpenSCAD's stderr on a failed one.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";
import { paramsToDefineArgs } from "./protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/web/public/wasm` — the vendored openscad-wasm CI build (PROVENANCE.md). */
const WASM_DIR = resolve(HERE, "..", "..", "public", "wasm");
/** The same BOSL2 checkout `bosl2Bundle.ts` inlines for the worker. */
const BOSL2_DIR = resolve(HERE, "..", "..", "..", "..", "packages", "libs", "vendor", "bosl2");

const [modelPath, outPath, paramsJson] = process.argv.slice(2);
const metaIndex = process.argv.indexOf("--meta");
const metaPath = metaIndex >= 0 ? process.argv[metaIndex + 1] : null;

if (!modelPath || !outPath) {
  console.error("usage: node nodeWasmRender.mjs <model.scad> <out.stl> [paramsJson] [--meta meta.json]");
  process.exit(2);
}

const params = paramsJson ? JSON.parse(paramsJson) : {};

/**
 * Reads the vendored BOSL2 `.scad` files into the same
 * `BOSL2/<filename>` → source map shape `bosl2Bundle.ts` builds for the
 * worker, so `include <BOSL2/std.scad>` resolves identically here.
 */
async function readBosl2() {
  const files = {};
  let names;
  try {
    names = (await readdir(BOSL2_DIR)).filter((n) => n.endsWith(".scad"));
  } catch {
    return files; // no vendored checkout — a model that needs BOSL2 will fail loudly in OpenSCAD
  }
  for (const name of names) {
    files[`BOSL2/${name}`] = await readFile(join(BOSL2_DIR, name), "utf8");
  }
  return files;
}

const t0 = performance.now();
const factory = (await import(join(WASM_DIR, "openscad.js"))).default;
// Node cannot `fetch()` the `file:` URL Emscripten's default loader builds;
// handing the bytes over directly is the supported escape hatch and skips
// `locateFile` entirely. Same binary, same instantiation path afterwards.
const wasmBinary = new Uint8Array(await readFile(join(WASM_DIR, "openscad.wasm")));
const bosl2 = await readBosl2();
const moduleLoadMs = performance.now() - t0;

const out = [];
const err = [];
const tRender = performance.now();

const instance = await factory({
  noInitialRun: true,
  wasmBinary,
  print: (text) => out.push(text),
  printErr: (text) => err.push(text)
});

instance.FS.mkdir("/libraries");
instance.FS.mkdir("/libraries/BOSL2");
for (const [path, text] of Object.entries(bosl2)) {
  instance.FS.writeFile(`/libraries/${path}`, text);
}

instance.FS.writeFile("/model.scad", await readFile(modelPath, "utf8"));

// Byte-for-byte the argv `openscad.worker.ts` builds, `paramsToDefineArgs`
// included — the whole point of importing that function rather than
// re-deriving the `-D` literals here.
const argv = [
  "/model.scad",
  "-o",
  "/out.stl",
  "--export-format=binstl",
  "--backend=manifold",
  ...paramsToDefineArgs(params)
];

// `callMain` mutates the array it is handed (Emscripten unshifts
// `thisProgram` onto it), so the recorded argv is a copy taken first.
const recordedArgv = [...argv];

let exitCode = -1;
let threw;
try {
  exitCode = instance.callMain(argv);
} catch (error) {
  threw = String(error?.stack ?? error);
}

const renderMs = performance.now() - tRender;

if (exitCode !== 0 || threw || !instance.FS.analyzePath("/out.stl").exists) {
  console.error([threw ? `[threw] ${threw}` : "", err.join("\n")].filter(Boolean).join("\n"));
  process.exit(1);
}

// Copy out of the wasm heap before the instance is discarded (same reason
// the worker does `.slice()` — the view is backed by memory about to go away).
await writeFile(outPath, Buffer.from(instance.FS.readFile("/out.stl").slice()));

if (metaPath) {
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        argv: recordedArgv,
        module_load_ms: Number(moduleLoadMs.toFixed(2)),
        render_ms: Number(renderMs.toFixed(2)),
        wasm_heap_bytes: instance.HEAPU8.byteLength,
        bosl2_file_count: Object.keys(bosl2).length,
        stderr: err.join("\n")
      },
      null,
      2
    ),
    "utf8"
  );
}
