// THROWAWAY spike worker (Issue #3).
//
// Loads the official openscad-wasm build (vendored under /wasm/, fetched
// from https://files.openscad.org/playground/OpenSCAD-2025.03.25.wasm24456-WebAssembly-web.zip,
// the same artifact openscad/openscad-playground's libs-config.json points
// at — GPL-2.0-or-later) inside this Web Worker, writes vendored BOSL2
// source (https://github.com/BelfrySCAD/BOSL2, BSD-2-Clause) into the
// Emscripten virtual FS, and runs the spike model 10 times to answer the
// instance-reuse + timing + manifold-backend questions. First tries reuse
// on one instance (confirmed broken — see freshInstance() below and the
// README's INSTANCE REUSE DECISION), then measures the working strategy:
// a fresh module instance per render.
//
// The overall shape (module worker, FS.writeFile before callMain,
// FS.readFile after) follows the pattern used by openscad-playground's
// src/runner/openscad-worker.ts (GPL2+) — no code copied verbatim, but the
// approach (fetch model source, write to FS, callMain, read output file)
// is the same one that repo uses, so noting it here per Issue #3's ask.

import { BOSL2_MODEL_SCAD } from "../model";

type OpenSCADInstance = {
  callMain: (args: string[]) => number;
  FS: {
    mkdir: (path: string) => void;
    writeFile: (path: string, data: string | Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
    analyzePath: (path: string) => { exists: boolean };
  };
  HEAPU8: Uint8Array;
};

type OpenSCADFactory = (opts: Record<string, unknown>) => Promise<OpenSCADInstance>;

interface RenderResult {
  ok: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  stlBytes?: Uint8Array;
  wasmHeapBytes: number;
}

async function loadManifestAndLibrary(): Promise<Map<string, string>> {
  const manifestRes = await fetch("/libraries/manifest.json");
  const manifest: { files: string[] } = await manifestRes.json();
  const entries = await Promise.all(
    manifest.files.map(async (path) => {
      const res = await fetch(`/libraries/${path}`);
      const text = await res.text();
      return [path, text] as const;
    }),
  );
  return new Map(entries);
}

function writeLibraryToFS(instance: OpenSCADInstance, files: Map<string, string>) {
  instance.FS.mkdir("/libraries");
  instance.FS.mkdir("/libraries/BOSL2");
  for (const [path, text] of files) {
    // path is e.g. "BOSL2/std.scad"
    instance.FS.writeFile(`/libraries/${path}`, text);
  }
}

function runOnce(
  instance: OpenSCADInstance,
  args: string[],
  outPath: string,
): { ok: boolean; ms: number; stdout: string; stderr: string; stlBytes?: Uint8Array } {
  let stdout = "";
  let stderr = "";
  // callMain doesn't take print callbacks per-call; print/printErr were
  // registered at instantiation time and route through `onOutput` below via
  // a mutable buffer captured in closure (see main() where instance is built).
  const capture = (globalThis as unknown as { __capture?: { out: string[]; err: string[] } })
    .__capture;
  if (capture) {
    capture.out.length = 0;
    capture.err.length = 0;
  }

  const t0 = performance.now();
  let exitCode = -1;
  let threw: string | undefined;
  try {
    exitCode = instance.callMain(args);
  } catch (e) {
    threw = String((e as Error)?.stack || e);
  }
  const ms = performance.now() - t0;

  if (capture) {
    stdout = capture.out.join("\n");
    stderr = capture.err.join("\n");
  }
  stderr = [threw ? `[threw] ${threw}` : "", `[exitCode] ${exitCode}`, stderr]
    .filter(Boolean)
    .join("\n");

  let stlBytes: Uint8Array | undefined;
  let ok = exitCode === 0;
  if (ok) {
    try {
      const exists = instance.FS.analyzePath(outPath).exists;
      if (!exists) {
        ok = false;
      } else {
        stlBytes = instance.FS.readFile(outPath);
        instance.FS.unlink(outPath); // don't let output files accumulate in FS between runs
      }
    } catch (e) {
      ok = false;
      stderr += `\n[read error] ${String(e)}`;
    }
  }
  return { ok, ms, stdout, stderr, stlBytes };
}

async function main() {
  const capture = { out: [] as string[], err: [] as string[] };
  (globalThis as unknown as { __capture: typeof capture }).__capture = capture;

  postMessage({ type: "status", message: "fetching wasm module + BOSL2 sources" });

  const t0 = performance.now();

  // Dynamic + @vite-ignore so Vite/Rollup does not try to statically bundle
  // the pre-built Emscripten glue file living under public/wasm/ (it must be
  // served untouched so its internal locateFile() logic finds openscad.wasm
  // next to it).
  const modUrl = new URL("/wasm/openscad.js", self.location.origin).href;
  const [{ default: OpenSCAD }, libraryFiles] = await Promise.all([
    import(/* @vite-ignore */ modUrl) as Promise<{ default: OpenSCADFactory }>,
    loadManifestAndLibrary(),
  ]);

  async function freshInstance(): Promise<OpenSCADInstance> {
    // IMPORTANT (see README INSTANCE REUSE DECISION): this build's callMain
    // is a one-shot per module instance. Tested empirically:
    //   - default options: 2nd callMain() on the same instance throws
    //     "program has already aborted!" (Emscripten tore the runtime down
    //     after main()'s implicit exit()).
    //   - noExitRuntime: true: the abort is suppressed, but the 2nd
    //     callMain() still throws (an opaque numeric exception — the
    //     unwound exit() — and wasm heap balloons to 3+ GB), i.e. OpenSCAD's
    //     own C++ global/static state (geometry cache, CGAL kernel) is not
    //     reset and the process is not safely re-enterable either way.
    // So: get a fresh module instance per render, reusing only the already
    // in-memory BOSL2 source text and the (browser-cached) compiled wasm
    // bytes — no new network fetch.
    const inst = await OpenSCAD({
      noInitialRun: true,
      print: (text: string) => capture.out.push(text),
      printErr: (text: string) => capture.err.push(text),
    });
    writeLibraryToFS(inst, libraryFiles);
    inst.FS.writeFile("/model.scad", BOSL2_MODEL_SCAD);
    return inst;
  }

  const instance = await freshInstance();

  const coldInitMs = performance.now() - t0;
  const bundleBytesEstimate = Array.from(libraryFiles.values()).reduce(
    (n, s) => n + s.length,
    0,
  );

  postMessage({
    type: "cold-init",
    coldInitMs,
    bosl2SourceBytes: bundleBytesEstimate,
    bosl2FileCount: libraryFiles.size,
  });

  // --- Manifold backend probe (single run, not counted in the 10-run series) ---
  const manifoldProbe = runOnce(
    instance,
    [
      "/model.scad",
      "-o",
      "/probe.stl",
      "--export-format=binstl",
      "--backend=manifold",
    ],
    "/probe.stl",
  );
  postMessage({
    type: "manifold-probe",
    ok: manifoldProbe.ok,
    ms: manifoldProbe.ms,
    stdout: manifoldProbe.stdout,
    stderr: manifoldProbe.stderr,
  });

  // --- Confirm same-instance reuse fails (1 extra call on the ORIGINAL
  // instance, already used once above for the manifold probe) ---
  const reuseAttempt = runOnce(
    instance,
    ["/model.scad", "-o", "/reuse-check.stl", "--export-format=binstl"],
    "/reuse-check.stl",
  );
  postMessage({
    type: "reuse-attempt",
    ok: reuseAttempt.ok,
    stderr: reuseAttempt.stderr,
  });

  // --- 10 sequential renders, each on a FRESH module instance (the
  // instance-reuse decision: re-instantiate per render). BOSL2 source is
  // reused from memory (no re-fetch); only module instantiation + FS writes
  // + callMain are repeated. Total wall time per iteration is what a real
  // "re-instantiate per render" strategy would cost end to end. ---
  const renders: RenderResult[] = [];
  for (let i = 0; i < 10; i++) {
    const tIter = performance.now();
    const inst = await freshInstance();
    const r = runOnce(
      inst,
      ["/model.scad", "-o", "/out.stl", "--export-format=binstl"],
      "/out.stl",
    );
    const totalMs = performance.now() - tIter;
    renders.push({ ...r, ms: totalMs, wasmHeapBytes: inst.HEAPU8.byteLength });
    postMessage({
      type: "render",
      index: i,
      ok: r.ok,
      ms: totalMs,
      callMainMs: r.ms,
      wasmHeapBytes: inst.HEAPU8.byteLength,
      stderr: r.ok ? "" : r.stderr,
    });
  }

  // Send the last successful STL back to main thread for three.js display.
  const last = [...renders].reverse().find((r) => r.ok && r.stlBytes);
  if (last?.stlBytes) {
    postMessage(
      { type: "mesh", stl: last.stlBytes.buffer },
      { transfer: [last.stlBytes.buffer] },
    );
  }

  postMessage({
    type: "done",
    renderMsSeries: renders.map((r) => r.ms),
    wasmHeapSeries: renders.map((r) => r.wasmHeapBytes),
    allOk: renders.every((r) => r.ok),
  });
}

main().catch((err) => {
  postMessage({ type: "fatal", message: String(err?.stack || err) });
});
