# Spike 1: openscad-wasm in a Vite Web Worker

Issue: [#3](https://github.com/KHAEntertainment/scadforge/issues/3) — Round 0 de-risking spike. **Throwaway code.** Bar is "reproducible with recorded measurements," not "shippable." Lives entirely under `spikes/01-wasm-preview/` (outside the pnpm workspace, never imported by product code) plus this README.

## What was built

A standalone Vite + TypeScript app (no framework, three.js for display) where:

- A **classic-thread Web Worker** (`src/worker/openscad.worker.ts`) dynamically imports the official openscad-wasm Emscripten glue (`public/wasm/openscad.js` + `openscad.wasm`), writes a vendored copy of BOSL2 into the Emscripten virtual filesystem, and compiles a ~50-line BOSL2 model (`src/model.ts`: a rounded base plate with four rounded corner posts and four through-holes, built with `cuboid()`, `cyl()`, `attach()`/`position()`, `diff()`/`tag()`).
- The main thread (`src/main.ts`) receives an exported STL mesh via `postMessage`, parses it with three.js's `STLLoader`, and displays it with `OrbitControls`. A stats panel (and mirrored `console.log("SPIKE_STATS_JSON", ...)`) shows every measurement below live.

### Wasm source (provenance)

No official `openscad-wasm` **npm package** exists. The current, real source (confirmed by inspecting `openscad/openscad-playground`'s `libs-config.json` on GitHub) is a dated CI artifact the OpenSCAD project publishes itself:

```
https://files.openscad.org/playground/OpenSCAD-2025.03.25.wasm24456-WebAssembly-web.zip
```

That zip (`openscad.js` + `openscad.wasm`, GPL-2.0-or-later, single-threaded — no `SharedArrayBuffer`/pthreads, so no COOP/COEP headers needed) was downloaded and vendored verbatim into `spikes/01-wasm-preview/public/wasm/`.

### BOSL2 source (provenance)

Vendored from `https://github.com/BelfrySCAD/BOSL2` (BSD-2-Clause), `.scad` files only (docs/tests/images stripped) into `spikes/01-wasm-preview/public/libraries/BOSL2/`, with a generated `manifest.json` (`scripts/gen-manifest.mjs`) the worker fetches to know which files to write into the Emscripten FS at `/libraries/BOSL2/*.scad`.

### GPL provenance note (per Issue #3's ask)

No code was copied verbatim from `openscad/openscad-playground`. The overall **shape** of the worker — instantiate the Emscripten module with `noInitialRun: true` and `print`/`printErr` callbacks, `FS.writeFile` the model + libraries, `callMain([...])`, `FS.readFile` the output — follows the same pattern used by that repo's `src/runner/openscad-worker.ts` (GPL-2.0-or-later), discovered by reading it for approach as the issue permits. This spike's fetch/write/callMain/read sequence and its "fresh instance per render" strategy (below) were arrived at independently, by testing, not ported.

## Reproduction

```bash
cd spikes/01-wasm-preview
npm install
npm run dev
# open the printed http://localhost:5173 URL
```

The dev server renders the BOSL2 part (visually confirmed — a rounded rectangular plate with four rounded corner posts and four mounting holes) within a few seconds of page load. All measurements below are mirrored to the browser console as `SPIKE_STATS_JSON` for headless capture; this session's own numbers were captured by driving the app in a real Chromium instance (network + console inspected directly, not estimated).

`npm run build` produces a production bundle (measurements below).

## Measurements (real, measured this session)

### Cold-init time

Two regimes, both real and both relevant to the product decision:

| Scenario | Cold-init time |
|---|---|
| **First-ever load** (empty HTTP cache — wasm binary + 56 individual BOSL2 file requests all go over the network) | **12,676 ms** (12.7 s) |
| **Repeat load** (browser HTTP cache warm — same session, reload) | **123–357 ms** (typically ~150 ms) |

"Cold-init" = wall time from Worker start (module + BOSL2-manifest fetch kickoff) to the first Emscripten module instance fully constructed and BOSL2 written into its FS.

**This is the single biggest real finding of this spike**: fetching BOSL2 as 56 separate small HTTP requests (one per `.scad` file, mirroring how this spike vendored it) is the dominant cost on a cold visit — worse than the 9.6 MB wasm binary itself, because of per-request/connection overhead. A product implementation should bundle BOSL2 as one archive (zip/tar, à la openscad-playground's approach) or a single concatenated file, not one fetch per file.

### Per-render time (fresh-instance strategy — see Instance Reuse Decision)

10 sequential renders of the ~50-line model, each on a **freshly instantiated** module (BOSL2 source reused from memory, no re-fetch):

| # | render ms | wasm heap bytes |
|---|---|---|
| 0 | 1707.4 | 24,248,320 |
| 1 | 1658.9 | 24,248,320 |
| 2 | 1676.0 | 24,248,320 |
| 3 | 1617.7 | 24,248,320 |
| 4 | 1597.3 | 24,248,320 |
| 5 | 1623.8 | 24,248,320 |
| 6 | 1598.0 | 24,248,320 |
| 7 | 1614.6 | 24,248,320 |
| 8 | 1575.1 | 24,248,320 |
| 9 | 1596.3 | 24,248,320 |

All 10 succeeded (`ok: true`). Mean ≈ **1627 ms/render**, range 1575–1707 ms, on a fresh instance each time (module instantiation + FS writes + full BOSL2 parse + CGAL/manifold render + STL export, all included). Wasm linear-memory footprint is **identical across all 10 fresh instances (24.25 MB / 23.13 MB reported)** — i.e., no accumulation, because each instance is discarded and a new one built.

(An earlier run interleaved with browser-automation screenshot calls showed two outliers, 15.2 s and 4.1 s, on an otherwise-identical series — attributed to main-thread contention from the automation tooling, not the worker itself; the clean re-run above is the number to trust.)

### Bundle size

Production build (`npm run build`), real file sizes:

| Asset | Size |
|---|---|
| `openscad.wasm` | 9,603,115 B (9.16 MB), gzip 2,929,174 B (2.79 MB) |
| `openscad.js` (Emscripten glue) | 124,567 B (122 KB) |
| Vendored BOSL2 source (56 `.scad` files) | 4,405,101 B (4.20 MB) uncompressed |
| App JS bundle (three.js + OrbitControls + STLLoader + app code) | 497,830 B (497.8 KB), gzip 125,330 B (125.3 KB) |
| Worker chunk (`openscad.worker.js`) | 3,650 B (3.65 KB) — tiny; it dynamic-`import()`s the glue at runtime rather than bundling it |
| **Total `dist/`** | **16 MB** |

## OUTPUT FORMAT DECISION

**Binary STL (`--export-format=binstl`), consumed by three.js's `STLLoader`.**

Findings that drove this:
- This wasm build's `callMain` supports (per its own `--help` text, confirmed by extracting embedded strings from `openscad.wasm`): `stl, off, wrl, amf, 3mf, csg, dxf, svg, pdf, png, echo, ast, term, nef3, nefdbg, param, pov`.
- **3MF is not actually usable in this build**: the wasm binary contains the literal string `"Export to 3MF format was not enabled when building the application."` — 3MF support was compiled out. (openscad-playground itself works around this by exporting OFF and hand-building a 3MF package client-side with `uzip` + `chroma-js` — real work, out of scope for this spike.)
- **GLB is not an OpenSCAD export format at all** — it never appears in the wasm's format list. openscad-playground synthesizes it client-side too, via `@gltf-transform/core` from a parsed OFF mesh.
- Binary STL, by contrast, worked immediately: `callMain(["/model.scad", "-o", "/out.stl", "--export-format=binstl"])` produced a valid mesh, parsed and displayed by three.js's stock `STLLoader` with zero extra code (confirmed visually — the rendered rounded plate + posts in the running app, matches the source model).

**Caveat**: STL carries no color/material data, which the product will eventually want (BOSL2 `color()`/multi-material parts). If per-face color becomes a hard requirement, the real options are: (a) do the OFF→3MF/GLB client-side conversion openscad-playground does (nontrivial extra code + deps), or (b) get a newer wasm build with 3MF actually enabled. Out of scope for this spike; flagged for the M2 preview architecture decision.

## INSTANCE REUSE DECISION

**Re-instantiate the wasm module per render.** Naive single-instance reuse across repeated `callMain()` calls **does not work** in this build — confirmed by direct testing, not inferred:

1. **Default options**: after the first successful `callMain()`, a second `callMain()` on the *same* instance throws `"program has already aborted!"` — Emscripten tears the runtime down (calls `exit()`) once `main()` returns, and the instance is unusable afterward.
2. **With `noExitRuntime: true`** (the standard Emscripten flag meant to keep an instance alive across multiple `main()` calls): the hard abort disappears, but the second `callMain()` still throws — an opaque unwound-`exit()` exception — **and the wasm linear memory balloons to ~3.39 GB** (`3,390,832,640` bytes measured) on that single failed second call, vs. ~24 MB for a normal successful render. OpenSCAD's own C++ global/static state (geometry cache, CGAL/manifold kernel singletons) is not reset between `main()` invocations, so the process is not safely re-enterable either way — `noExitRuntime` just changes the failure mode from a clean abort to memory blowup.
3. **Fresh instance per render** (call the `OpenSCAD({...})` factory again, reusing only the already-in-memory BOSL2 source text and the browser's compiled-wasm cache — no new network fetch): **works reliably** — all 10 renders in the measured series above succeeded, at a stable ~1.6 s/render, with **identical wasm heap size on every instance (24.25 MB, no growth or leak across instances)**.

Recommendation for the M2 preview architecture: **one Worker, re-instantiate the OpenSCAD module per render inside it.** A full Worker-pool is not needed to solve *this* problem (module re-instantiation, not worker creation, is what's cheap-enough-but-not-free at ~1.6 s including the full BOSL2 parse); a pool could still be worth it later purely for UI responsiveness (running a render without blocking a queued second request), but that's a separate concern from the reuse question this spike was asked to answer.

## MANIFOLD BACKEND FINDING

**`--backend=manifold` works in this wasm build.** (`--enable=manifold` is a different, older mechanism — this build's `--enable=<feature>` list doesn't include "manifold"; it graduated to its own `--backend` flag, matching what openscad-playground itself passes on every render.)

Measured: `callMain(["/model.scad", "-o", "/probe.stl", "--export-format=binstl", "--backend=manifold"])` → exit code 0, ~665–840 ms, stdout confirms:

```
Top level object is a 3D object (manifold):
   Status:     NoError
   Genus:      0
   Vertices:      144
   Facets:        284
```

vs. the default CGAL backend (no `--backend` flag) used for all 10 timed renders above, which also succeeded (144 vertices / 216 edges / 74 facets reported by local CLI validation — see below) but is generally slower for non-trivial geometry per OpenSCAD's own documentation. Given the product's separate `manifold-3d` npm validation step (Issue #6) and the render-authority split (server CLI is authoritative; WASM is convenience-only), `--backend=manifold` is safe to use for WASM preview renders to keep them fast.

## Acceptance criteria verification

| Trigger | Actual behavior |
|---|---|
| `cd spikes/01-wasm-preview && npm install && npm run dev`, open browser | Page loads, worker boots, BOSL2 model (rounded plate + 4 rounded corner posts + 4 holes) renders and is visually confirmed in three.js with OrbitControls. Console mirrors every stat as `SPIKE_STATS_JSON`. |
| README records cold-init, per-render, bundle size | Recorded above with real numbers (12.68 s cold / ~150 ms warm cold-init; ~1.6 s/render mean over 10 fresh-instance renders; 16 MB total `dist/`, itemized by asset). |
| README records OUTPUT FORMAT DECISION | Binary STL + three.js `STLLoader`, with the 3MF/GLB compiled-out/unsupported findings documented above. |
| README records INSTANCE REUSE DECISION | Re-instantiate per render; same-instance reuse empirically confirmed broken two ways (clean abort by default, memory blowup + throw with `noExitRuntime`). |
| README records `--backend=manifold` finding | Confirmed working, ~665–840 ms, exit code 0, manifold-specific success output captured. |
| README ends with GO/NO-GO + PROJECT_CONTEXT.md decisions block | Below. |

## Known limitations of this spike (throwaway scope, not gaps to fix here)

- BOSL2 is fetched as 56 individual files (matches the found cold-init cost above); a real implementation should ship it as one archive.
- No param sliders, no product wiring, no error-surface UI polish — out of scope per the issue.
- Only tested in one Chromium-based browser on one machine; no cross-browser/mobile measurement.
- The STL round-trip carries no color; multi-material BOSL2 parts will look flat until a color-capable format is wired up (see Output Format caveat above).

---

## GO

## Decisions for PROJECT_CONTEXT.md

- **WASM output format + three.js loader**: Binary STL (`--export-format=binstl`) + three.js `STLLoader`. 3MF export is compiled out of this wasm build (confirmed via embedded string); GLB is not a native OpenSCAD export format. Revisit if per-face color becomes a hard requirement (would need client-side OFF→3MF/GLB conversion, ~openscad-playground's approach).
- **WASM instance reuse vs re-instantiation**: Re-instantiate the OpenSCAD module per render, inside one long-lived Worker. Same-instance `callMain()` reuse is broken in this build (confirmed: clean abort by default; throw + ~3.4 GB memory blowup with `noExitRuntime: true`). Fresh-instance-per-render measured stable at ~1.6 s/render with no cross-instance memory growth (constant 24.25 MB wasm heap across 10 renders).
- **Wasm source**: no official npm package exists; vendor/fetch the dated CI build from `https://files.openscad.org/playground/OpenSCAD-<date>.wasm<build>-WebAssembly-web.zip` (same source openscad-playground itself uses) — this is a moving target with no "latest" alias, so the product build should pin a specific dated URL and re-vet on update.
- **`--backend=manifold` flag**: confirmed working in this wasm build; safe to use for WASM preview renders (WASM render is convenience-only, server CLI remains authoritative per existing architecture decision).
- **BOSL2 delivery**: do not fetch as individual files (56 requests dominated cold-init time, ~12.7 s vs ~150 ms warm). Ship as a single archive/bundle for the real product implementation.
