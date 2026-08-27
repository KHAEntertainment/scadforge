// GPL ZONE — Issue #31.
//
// Message protocol between the main thread (WasmPreviewClient) and the
// openscad-wasm Web Worker (openscad.worker.ts). Kept dependency-free (no
// GPL glue imported here) so it is safe for `WasmPreviewClient` to import
// from the main thread without pulling any openscad-wasm code out of the
// worker boundary.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ParamValue, ParamValues } from "@scadforge/protocol";

/** Main thread → worker. */
export interface WasmRenderRequestMessage {
  type: "render";
  requestId: string;
  scad: string;
  params: ParamValues;
}

/** Worker → main thread. */
export type WasmWorkerMessage =
  | {
      type: "cold-init";
      /** Wall time from worker script start to the BOSL2 bundle + wasm glue import resolving (module not yet instantiated — see `instance-ready`). */
      moduleLoadMs: number;
      bosl2FileCount: number;
      bosl2SourceBytes: number;
    }
  | {
      type: "result";
      requestId: string;
      ok: true;
      /** Binary STL bytes (`--export-format=binstl`), transferred (not copied). */
      stl: ArrayBuffer;
      /** Wall time for this render: fresh module instantiation + FS writes + callMain + STL read. */
      ms: number;
      /** OpenSCAD stdout, in case future UI wants it; not surfaced by default. */
      stdout: string;
      /** wasm linear-memory size at the end of this render (Spike 1's leak-detection signal). */
      wasmHeapBytes: number;
    }
  | {
      type: "result";
      requestId: string;
      ok: false;
      /** Filtered OpenSCAD stderr (AC: surfaced verbatim to the UI, not a generic failure). */
      stderr: string;
      ms: number;
    }
  | {
      /** The worker's module/BOSL2 loading (or a render) threw outside the normal ok/stderr path. */
      type: "fatal";
      requestId: string | null;
      message: string;
    };

/**
 * Serializes one Customizer parameter value into an OpenSCAD `-D` literal
 * (SDP §11 Customizer syntax; values are plain OpenSCAD expressions, not
 * JSON). Used to pass `params` from the current project into the WASM
 * preview render via `-D name=<literal>` command-line overrides.
 *
 * Counterexample coverage (see protocol.test.ts): empty string, string with
 * embedded quotes/backslashes, empty array, mixed-sign numbers, negative
 * zero, boolean arrays.
 */
export function paramValueToScadLiteral(value: ParamValue): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "0"; // OpenSCAD has no NaN literal; fail safe rather than emit invalid syntax
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return scadStringLiteral(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => paramValueToScadLiteral(entry as ParamValue)).join(",")}]`;
  }
  // Exhaustiveness guard — ParamValue is a closed union; a new variant fails to build here.
  const _exhaustive: never = value;
  return _exhaustive;
}

function scadStringLiteral(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/**
 * Builds the `-D name=value` argv entries for a `ParamValues` bag, in a
 * stable (sorted) order so identical params always produce identical argv —
 * relevant for any future render-result caching.
 */
export function paramsToDefineArgs(params: ParamValues): string[] {
  return Object.keys(params)
    .sort()
    .flatMap((name) => ["-D", `${name}=${paramValueToScadLiteral(params[name])}`]);
}
