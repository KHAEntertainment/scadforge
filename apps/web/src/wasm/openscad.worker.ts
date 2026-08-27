// GPL ZONE — Issue #31. Reimplemented from scratch for the product (per the
// issue's ask, spike code is reference-only and not imported). The overall
// SHAPE below — instantiate the Emscripten module with `noInitialRun: true`
// and `print`/`printErr` callbacks, `FS.writeFile` the model + libraries,
// `callMain([...])`, `FS.readFile` the output, one fresh module instance per
// render — follows the same pattern openscad/openscad-playground's
// `src/runner/openscad-worker.ts` (GPL-2.0-or-later) uses, discovered by
// reading that repo for approach during Issue #3 (Spike 1), and confirmed by
// this project's own empirical testing (see PROJECT_CONTEXT.md "WASM preview
// (M2)" and docs/spikes/01-wasm-preview/README.md's INSTANCE REUSE DECISION).
// No code was copied verbatim from openscad-playground.
//
// openscad.js/.wasm themselves (imported below from /wasm/, unhashed public
// assets) are the official openscad-wasm CI build, GPL-2.0-or-later — see
// apps/web/public/wasm/PROVENANCE.md.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { BOSL2_FILE_COUNT, BOSL2_FILES, BOSL2_SOURCE_BYTES } from "./bosl2Bundle.js";
import { paramsToDefineArgs } from "./protocol.js";
import type { WasmRenderRequestMessage, WasmWorkerMessage } from "./protocol.js";

/** Minimal shape of the Emscripten module instance this worker touches. */
interface OpenScadInstance {
  callMain: (args: string[]) => number;
  FS: {
    mkdir: (path: string) => void;
    writeFile: (path: string, data: string | Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
    analyzePath: (path: string) => { exists: boolean };
  };
  HEAPU8: Uint8Array;
}

type OpenScadFactory = (opts: Record<string, unknown>) => Promise<OpenScadInstance>;

function post(message: WasmWorkerMessage, transfer?: Transferable[]) {
  // `postMessage` on a DedicatedWorkerGlobalScope accepts a transfer list as
  // the 2nd arg; typed narrowly here rather than pulling in the full
  // `lib.webworker.d.ts` (which conflicts with this project's DOM-lib
  // tsconfig when both are on the same TS program).
  (self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void }).postMessage(
    message,
    transfer ?? []
  );
}

const t0 = performance.now();

// Dynamic + @vite-ignore: this must be requested as a plain URL, not
// statically bundled — it's a pre-built, unprocessed Emscripten glue file
// whose own internal `locateFile()` needs to find `openscad.wasm` sitting
// unhashed next to it (see apps/web/public/wasm/PROVENANCE.md).
const glueUrl = new URL("/wasm/openscad.js", self.location.origin).href;
const openScadFactoryPromise = (
  import(/* @vite-ignore */ glueUrl) as Promise<{ default: OpenScadFactory }>
).then((mod) => mod.default);

const moduleReadyPromise = openScadFactoryPromise.then((factory) => {
  const moduleLoadMs = performance.now() - t0;
  post({
    type: "cold-init",
    moduleLoadMs,
    bosl2FileCount: BOSL2_FILE_COUNT,
    bosl2SourceBytes: BOSL2_SOURCE_BYTES
  });
  return factory;
});

/**
 * Re-instantiates the OpenSCAD module from scratch (INSTANCE REUSE DECISION,
 * PROJECT_CONTEXT.md "WASM preview (M2)"): same-instance `callMain()` reuse
 * is broken in this wasm build (clean abort by default; ~3.4GB heap blowup +
 * throw with `noExitRuntime: true`). A fresh instance per render, reusing
 * only the already-in-memory BOSL2 text and the browser's wasm-compile
 * cache, is the confirmed-working strategy.
 */
async function freshInstance(capture: { out: string[]; err: string[] }): Promise<OpenScadInstance> {
  const factory = await moduleReadyPromise;
  const instance = await factory({
    noInitialRun: true,
    print: (text: string) => capture.out.push(text),
    printErr: (text: string) => capture.err.push(text)
  });

  instance.FS.mkdir("/libraries");
  instance.FS.mkdir("/libraries/BOSL2");
  for (const [path, text] of Object.entries(BOSL2_FILES)) {
    instance.FS.writeFile(`/libraries/${path}`, text);
  }

  return instance;
}

async function render(scad: string, params: WasmRenderRequestMessage["params"]) {
  const capture = { out: [] as string[], err: [] as string[] };
  const t0Render = performance.now();

  const instance = await freshInstance(capture);
  instance.FS.writeFile("/model.scad", scad);

  const argv = [
    "/model.scad",
    "-o",
    "/out.stl",
    "--export-format=binstl",
    "--backend=manifold",
    ...paramsToDefineArgs(params)
  ];

  let exitCode = -1;
  let threw: string | undefined;
  try {
    exitCode = instance.callMain(argv);
  } catch (err) {
    threw = String((err as Error)?.stack ?? err);
  }

  const ms = performance.now() - t0Render;
  const wasmHeapBytes = instance.HEAPU8.byteLength;

  const stderrText = [threw ? `[threw] ${threw}` : "", capture.err.join("\n")].filter(Boolean).join("\n");

  if (exitCode !== 0 || threw) {
    return {
      ok: false as const,
      stderr: stderrText || `OpenSCAD exited with code ${exitCode}`,
      ms
    };
  }

  if (!instance.FS.analyzePath("/out.stl").exists) {
    return { ok: false as const, stderr: stderrText || "OpenSCAD reported success but wrote no STL output.", ms };
  }

  const stlBytes = instance.FS.readFile("/out.stl");
  // Copy out of the wasm heap before the instance/heap is discarded (the
  // Uint8Array view would otherwise be backed by memory this fresh-instance
  // strategy is about to throw away).
  const stlCopy = stlBytes.slice().buffer;

  return { ok: true as const, stl: stlCopy, ms, stdout: capture.out.join("\n"), wasmHeapBytes };
}

self.addEventListener("message", (event: MessageEvent<WasmRenderRequestMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== "render") return;

  const { requestId, scad, params } = msg;

  render(scad, params)
    .then((result) => {
      if (result.ok) {
        post(
          {
            type: "result",
            requestId,
            ok: true,
            stl: result.stl,
            ms: result.ms,
            stdout: result.stdout,
            wasmHeapBytes: result.wasmHeapBytes
          },
          [result.stl]
        );
      } else {
        post({ type: "result", requestId, ok: false, stderr: result.stderr, ms: result.ms });
      }
    })
    .catch((err) => {
      post({ type: "fatal", requestId, message: String((err as Error)?.stack ?? err) });
    });
});
