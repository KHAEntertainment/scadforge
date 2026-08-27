# openscad-wasm vendored binary — provenance (Issue #31, GPL zone)

`openscad.js` + `openscad.wasm` in this directory are the **official
openscad-wasm CI build**, not a Claude/product build:

```
https://files.openscad.org/playground/OpenSCAD-2025.03.25.wasm24456-WebAssembly-web.zip
```

This is the same dated artifact `openscad/openscad-playground`'s
`libs-config.json` points at (confirmed by Spike 1, Issue #3). It was
downloaded once for the Spike 1 throwaway app
(`spikes/01-wasm-preview/public/wasm/`) and is copied here **byte-for-byte,
unmodified** — no rebuild, no patch. License: **GPL-2.0-or-later**
(single-threaded build — no `SharedArrayBuffer`/pthreads, so no COOP/COEP
response headers are required to use it).

## Why these two files live under `public/wasm/`, not `src/wasm/`

Emscripten's default `locateFile` resolves `openscad.wasm` **relative to
`openscad.js`'s own served path**, using the literal filename
`openscad.wasm`. Vite's asset pipeline (`?url` imports from `src/`) would
hash the output filename, breaking that lookup. `public/` assets are
copied to the build output **verbatim, unhashed, at the same path** — the
same reason Spike 1 used `public/wasm/` — so this pairing is guaranteed to
resolve correctly in both dev and a production build. This is still part
of the Issue #31 GPL zone: everything under `apps/web/public/wasm/**` and
`apps/web/src/wasm/**` together make up the enforced boundary (CLAUDE.md
hard rule 1) — nothing outside those two paths may import GPL-derived
openscad-wasm code or reference these binaries directly.

## Re-vetting

This is a moving-target CI artifact with no "latest" alias (Spike 1
finding). Re-download and re-vet the dated URL above before bumping to a
newer OpenSCAD wasm build; do not silently swap in an unpinned "latest".
