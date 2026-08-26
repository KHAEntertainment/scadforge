# CLAUDE.md — ScadForge

Natural-language → parametric OpenSCAD builder. Read `PROJECT_CONTEXT.md` for architecture decisions and `docs/SDP.md` for the full design. Task system: GitHub Issues/PRs (this repo). Development runs under the `/dev` multi-agent SOP.

## Commands

```bash
pnpm install          # workspace install (spikes/ are standalone — cd into them separately)
pnpm -r build         # build all packages
pnpm -r test          # vitest everywhere; @docker-tagged tests need the OpenSCAD container
pnpm lint             # eslint
node scripts/check-licenses.mjs   # license gate (also runs in CI)
```

Always prefer RTK wrappers: `rtk git`, `rtk gh`, `rtk npm`, `rtk tsc`, `rtk lint`, or `rtk proxy <cmd>`.

## Hard rules

1. **License boundary**: GPL-derived code (openscad-playground ports, openscad-wasm glue) is allowed ONLY under `apps/web/src/wasm/**`. `packages/agent`, `packages/scad-core`, `packages/protocol`, `packages/mcp-server` must stay GPL-free (Apache-2.0 headers, no GPL deps). CI enforces via `scripts/check-licenses.mjs`.
2. **Contract freeze**: `packages/protocol/**`, `packages/scad-core/src/types.ts`, `packages/agent/src/tools/contract.ts` are Tech-Lead-owned once their freeze issue merges. Never edit them inside a feature PR — comment on your issue instead.
3. **One route file per resource** in `apps/server/src/routes/` (projects, chat, snapshots, renders, params, export) so parallel workers can own individual files.
4. **Agent loop cap**: max 2 autonomous self-correction passes per user turn (`SCADFORGE_MAX_PASSES`); stop early when validation is green.
5. **Never paste full `.scad` into chat** — agents hand back short summaries; the Code tab shows the file.
6. **Server render is authoritative.** WASM preview is a convenience; it must degrade to the last server render on failure/timeout.
7. **Validation gates export**: `export` runs `validate_mesh` first and refuses (with explicit override) on failure.
8. **`spikes/` is not part of the workspace** and must never be imported by product code.
9. **No auth, no database** — local-first, filesystem store (`.scadforge/`). Do not introduce either.

## Pinned toolchain

- Node 22, pnpm
- OpenSCAD nightly (Docker): **pin TBD — set by Spike 2 (#4); recorded here + `docker/openscad.Dockerfile` + PROJECT_CONTEXT.md.** Required flags verified by spike: `--backend=manifold`, `--export-format=3mf` (colors), `--export-format=param`, fixed `--camera` presets.

## Units & conventions

- All geometry in **mm**. Customizer parameter syntax for every exposed parameter (`// [min:max]`, `// [a, b, c]`, `/* [Section] */`). Parameters first, helpers second, geometry last. `$fn` discipline: coarse default, fine on export.
