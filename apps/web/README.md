# @scadforge/web

Vite + React + TypeScript web app (SDP §11): the chat panel, three.js
viewport (`@react-three/fiber` + drei), Monaco editor, and Konva annotate
overlay (Round 3) all live here.

- `src/components/` — UI components (land with their feature issues).
- `src/wasm/` — **GPL zone**. openscad-wasm glue and any GPL-derived ports
  (openscad-playground) are allowed ONLY under this directory
  (CLAUDE.md hard rule 1 / PROJECT_CONTEXT.md license boundary). The WASM
  preview must degrade gracefully to the last server render on
  failure/timeout — server CLI render is authoritative.
- `src/lib/` — client-side helpers.

Today this app only renders a "ScadForge" placeholder root component.

License: GPL-3.0-or-later (repo default; the `src/wasm/**` GPL zone lives
inside this app, so the whole app stays under the repo license, not
Apache-2.0).
