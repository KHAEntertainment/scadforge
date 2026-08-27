// GPL ZONE — Issue #31.
//
// BOSL2 SOURCE PROVENANCE: vendored from https://github.com/BelfrySCAD/BOSL2
// (BSD-2-Clause), pinned commit documented at
// `packages/libs/vendor/bosl2/PROVENANCE.md` — the SAME checkout
// `@scadforge/libs` uses server-side for `library_lookup` (Issue #19). This
// module does not re-vendor a second copy of BOSL2 into the repo; it reads
// that existing checkout directly via Vite's `?raw` glob import.
//
// COLD-INIT FIX (Issue #31 AC): Spike 1 found fetching BOSL2 as 56 separate
// `.scad` HTTP requests dominates cold-init (12.7s uncached — per-request
// overhead, worse than the 9.2MB wasm binary itself). `import.meta.glob(...,
// { eager: true, query: "?raw" })` below makes Vite/Rollup inline every
// file's text as a plain JS string constant into the worker's OWN bundled
// chunk at build time. The browser then fetches this content as part of the
// worker script it was already loading — zero additional HTTP requests for
// BOSL2, in dev or in a production build. See openscad.worker.ts for the
// before/after cold-init measurement.
//
// SPDX-License-Identifier: GPL-3.0-or-later (this file); BOSL2 content
// itself is BSD-2-Clause (see packages/libs/vendor/bosl2/LICENSE).

// `eager: true` resolves synchronously at module-eval time (no dynamic
// import() per file); `query: "?raw", import: "default"` gets Vite to hand
// back the raw file text instead of trying to parse `.scad` as JS/CSS/etc.
const rawModules = import.meta.glob("../../../../packages/libs/vendor/bosl2/*.scad", {
  eager: true,
  query: "?raw",
  import: "default"
}) as Record<string, string>;

/**
 * `BOSL2/<filename>.scad` → source text, matching the FS layout the wasm
 * worker writes into the Emscripten virtual filesystem (`/libraries/BOSL2/`)
 * — the same convention Spike 1 confirmed works for this openscad-wasm
 * build's default include search path.
 */
export const BOSL2_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(rawModules).map(([path, text]) => {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    return [`BOSL2/${filename}`, text];
  })
);

export const BOSL2_FILE_COUNT = Object.keys(BOSL2_FILES).length;

export const BOSL2_SOURCE_BYTES = Object.values(BOSL2_FILES).reduce(
  (total, text) => total + text.length,
  0
);
