# ScadForge

**Describe a part. Generate editable OpenSCAD. Inspect and refine the model.**

ScadForge is a local-first, single-user CAD workspace that turns natural-language
requests into parametric [OpenSCAD](https://openscad.org/) models. A Claude agent
writes the source, renders views, checks the mesh, and can correct its work before
returning a result. You can adjust exposed parameters, inspect the 3D preview,
revisit snapshots, and export the model.

**Status: early development.** The chat-to-model workflow and browser parameter
preview are implemented. The visual editing workflow and release packaging are
still in development; the MCP server package is currently a placeholder.

## What it does

- **Chat-driven modeling:** create and revise models through a streamed chat,
  with tool activity and model usage visible in the workspace.
- **Parametric refinement:** edit OpenSCAD Customizer parameters and preview
  changes in the browser using OpenSCAD WASM.
- **Model inspection:** view the mesh, inspect dimensions, and read validation
  results, including manifoldness, volume, and bounding box.
- **Project history and export:** keep source, parameters, renders, and validation
  in a filesystem project store with snapshots and downloadable exports.
- **Library-aware generation:** look up symbols in the vendored BOSL2 and MCAD
  libraries while building a model.

Server-side OpenSCAD renders are authoritative. The browser WASM preview is a
convenience layer and falls back to the last server render if it fails.

## Run locally

You need **Node.js 22+**, **pnpm 11.24.0** (the version pinned in
[`package.json`](package.json)), and a running **Docker daemon with Compose**.
Live chat also requires an Anthropic API key. Model requests use your credentials
and incur provider charges; see the
[Claude Agent SDK setup guide](https://code.claude.com/docs/en/agent-sdk/quickstart).

The commands below use a macOS/Linux shell. Run them from the repository root.

1. Clone, install dependencies, and build the workspace:

   ```bash
   git clone https://github.com/KHAEntertainment/scadforge.git
   cd scadforge
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. Build and verify the pinned OpenSCAD image:

   ```bash
   docker compose build openscad
   docker compose run --rm openscad --version
   ```

   This should print OpenSCAD version `2026.01.19`. The container exits after the
   check; the API starts separate containers when rendering or exporting.

3. Start the API in one terminal:

   ```bash
   export ANTHROPIC_API_KEY='your-api-key'
   # Optional: export SCADFORGE_MODEL='<model-id>'
   PORT=3001 SCADFORGE_PROJECTS_DIR="$PWD/data/projects" node apps/server/dist/index.js
   ```

   Set the key in the API process environment; the app does not automatically
   load a `.env` file. Choose `SCADFORGE_MODEL` explicitly if you want to control
   which model is used; otherwise the SDK chooses its default.

4. Start the web app in a second terminal:

   ```bash
   pnpm --filter @scadforge/web exec vite --port 5173
   ```

5. Open **http://localhost:5173**, create a project, and describe a part. For
   example: “Make a rectangular tray, 100 by 60 mm, with 3 mm walls and rounded
   corners.” The status strip should show the pinned OpenSCAD version.

Project data is stored under `data/projects` in this setup, including each
project's `.scadforge/` history. That directory is gitignored. Keep it if you want
to retain your models between sessions.

This app has no authentication and is intended for trusted local use. Do not
expose the API or development server to the public internet.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `SCADFORGE_PROJECTS_DIR` | Filesystem project root | `data/projects`, relative to the working directory |
| `SCADFORGE_MODEL` | Model passed to the Claude Agent SDK | SDK default |
| `SCADFORGE_MAX_PASSES` | Maximum autonomous write/correction passes per turn | `2` |
| `SCADFORGE_OPENSCAD_IMAGE` | Docker image used for server-side CAD | `scadforge-openscad:pinned` |
| `PORT` / `SCADFORGE_API_URL` | API port / Vite's API proxy target | `3001` / `http://localhost:3001` |

For example, if you start the API on port `4001`, start Vite with
`SCADFORGE_API_URL=http://localhost:4001`. See the
[web development guide](apps/web/README.md#dev-proxy) and
[Docker guide](docker/README.md) for details.

## Repository layout

The project is a TypeScript pnpm monorepo. React, Vite, and three.js provide the
browser workspace; a Hono API connects it to the agent and CAD runtime. There is
no database.

| Path | Responsibility |
| --- | --- |
| [`apps/web`](apps/web/README.md) / [`apps/server`](apps/server/README.md) | Browser workspace and REST/SSE API |
| [`packages/agent`](packages/agent/README.md) / [`packages/protocol`](packages/protocol/README.md) | Claude Agent SDK integration and shared API contracts |
| [`packages/scad-core`](packages/scad-core/README.md) / [`packages/libs`](packages/libs/README.md) | OpenSCAD execution, validation, project store, and vendored library lookup |
| [`packages/mcp-server`](packages/mcp-server/README.md) | Placeholder for a future stdio MCP host |
| [`docs`](docs/SDP.md) / [`spikes`](spikes) / [`evals`](evals) | Design notes, feasibility work, and evaluation harnesses; `spikes/` is outside the workspace |

## Development checks

Run these from the repository root with Docker available so the container-based
tests execute:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
pnpm lint
node scripts/check-licenses.mjs
```

Run only one full test suite at a time on a shared machine. For the full
verification rules, see [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md#verification-gate).
Report bugs or propose changes through
[GitHub issues](https://github.com/KHAEntertainment/scadforge/issues).

## License

The repository's default license is **GPL-3.0-or-later**; see [`LICENSE`](LICENSE).
`packages/agent`, `packages/scad-core`, `packages/protocol`, and
`packages/mcp-server` are **Apache-2.0** packages. Check each package's license
metadata and source headers for its scope.

Vendored libraries retain their own licenses: **BOSL2 is BSD-2-Clause** and
**MCAD is LGPL-2.1**. Their license files and provenance are documented in
[`packages/libs`](packages/libs/README.md#vendored-libraries). GPL-derived browser
integration code is confined to `apps/web/src/wasm/`; the license gate checks
that it does not enter the Apache-licensed packages.
