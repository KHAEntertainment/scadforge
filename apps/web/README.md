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
- `src/lib/` — client-side helpers, including `apiClient.ts` (the typed REST
  client — see Issue #36 below) and `sse.ts` (chat stream parsing).

License: GPL-3.0-or-later (repo default; the `src/wasm/**` GPL zone lives
inside this app, so the whole app stays under the repo license, not
Apache-2.0).

## Local demo boot sequence

The web app talks to `apps/server` over `/api/*`, forwarded by a Vite dev
proxy (see "Dev proxy" below) — it never guesses a server port itself. Three
things need to be running, in this order, each in its own terminal from the
repo root:

```bash
# 1. Pinned OpenSCAD image (Docker) — builds/verifies the image apps/server
#    shells out to for every render/export. One-shot; prints the pinned
#    version and exits.
docker compose up openscad

# 2. API server — build once, then run. Point SCADFORGE_PROJECTS_DIR at a
#    scratch directory; it's created if missing.
pnpm --filter @scadforge/server build
PORT=3001 SCADFORGE_PROJECTS_DIR=/tmp/scadforge-demo node apps/server/dist/index.js

# 3. Web app (dev server with the API proxy wired in)
pnpm --filter @scadforge/web exec vite --port 5173
```

Then open **http://localhost:5173** — the project list should load and the
status strip should show the real pinned OpenSCAD version (currently
`2026.01.19`), with no error banner.

### Dev proxy

`apps/web/vite.config.ts` proxies `/api/*` to the API server so the browser
never needs a cross-origin request (there is no CORS layer in `apps/server`
— see Issue #36). The target defaults to `http://localhost:3001` and is
configurable without editing the config file:

```bash
SCADFORGE_API_URL=http://localhost:4001 pnpm --filter @scadforge/web exec vite --port 5173
```

(`VITE_API_PROXY_TARGET` is also accepted, for parity with Vite's usual
`VITE_`-prefixed env var convention.)

Production/`docker compose` serving of the built web app from `apps/server`
(same-origin, no proxy needed) is out of scope here — that's M4 release
packaging.
