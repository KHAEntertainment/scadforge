# Scenario A2 — M2 integration harness (Issue #35)

Deterministic, non-interactive proof that the parametric loop works end-to-end
through the REAL server HTTP API and the REAL agent tool-handler seam. It uses
**zero live-model turns**: `set_params` is exercised through the actual
`createToolHandlers(...).handlers.set_params` seam (the same function a live
agent turn calls), not through a model provider.

## What it proves

| Assertion | What it checks |
| --- | --- |
| `AC1` | Customizer schema exposes `wall` (`initial`/`min`/`max`/`step`) over REST |
| `AC2-wall{2,4.5,6}` | WASM/server volume **and all six bbox min/max coordinates** agree within tolerance at 3 settings |
| `AC3` | Server volume strictly increases with `wall` |
| `AC7-wall{2,4.5,6}` | `ExportResponse.validation` reflects the actual preview-override params, not a stale head snapshot |
| `AC4a` | `set_params` via the real tool-handler seam is visible over REST |
| `AC4b` | The parameter edit (wall 3→4) changes authoritative server-rendered geometry |
| `AC5` | Revert creates a NEW snapshot restoring scad+params |
| `AC6` | Revert restores the target snapshot's render PNGs + mesh byte-for-byte (SHA-256) |
| `AC8` | The original snapshot's scad/renders/mesh are byte-identical after set_params + revert (history immutability) |

## Prerequisites

- **Build**: `pnpm -r build` must have produced `apps/server/dist/`,
  `packages/scad-core/dist/`, and `packages/agent/dist/`. The harness reaches
  them via relative `file://` imports — no workspace dependency.
- **Docker + pinned image**: the server renders through the pinned OpenSCAD
  image (`scadforge-openscad:pinned` / digest
  `openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7`,
  version `2026.01.19`). A default run verifies it via
  `docker compose up --build openscad` first; `--no-compose` skips that step.
- **Node 22** (CI-pinned runtime). Local: `/opt/homebrew/opt/node@22/bin/node`
  (v22.23.2). The harness spawns the server and the WASM renderer with the
  same `process.execPath`, so running the harness under Node 22 runs the whole
  stack under Node 22.

## Usage

```text
node evals/scenario-a2/run.mjs [--keep] [--project-root DIR] [--no-compose] [--negative-control]
```

| Flag | Effect |
| --- | --- |
| `--keep` | Leave the temp project directory behind for inspection |
| `--project-root DIR` | Use `DIR` as the project store (never auto-deleted) |
| `--no-compose` | Skip `docker compose up --build openscad` (image already present) |
| `--negative-control` | Append a deliberately-failing assertion; the run must exit 1 |

CI invocation (after the pinned-image + workspace build):

```text
node evals/scenario-a2/run.mjs --no-compose
```

The harness defaults to port **3298**. Set `SCADFORGE_A2_EVAL_PORT` to use
another available port; an occupied port causes startup to fail.

## Expected results

- Normal run: **13/13 assertions pass, exit code 0.**
- Negative control (`--negative-control`): 13/14 (the injected `ACNEG` fails),
  **exit code 1** — proving a failing assertion really produces a non-zero exit.

Evidence is written to `evals/scenario-a2/evidence/` (`transcript-*.log` +
`results-*.json`) on success and on failure.

## Tolerance

WASM/server agreement tolerances (see the rationale block in `run.mjs`):

- **Volume**: 0.5 % relative to the server volume.
- **Bbox**: 0.1 mm absolute, on all six min/max coordinates.

The server (Docker OpenSCAD 2026.01.19) and the WASM build
(openscad-wasm 2025.03.25) are ~10 months apart and use independently-compiled
Manifold binaries, so some polygonization noise is expected at the fixture's
`$fn=48`; the tolerance is sized from that chord error (~0.01 mm/facet), not an
arbitrary epsilon. These constants are **fixed** — a measured delta near or
past them is a real divergence to diagnose, never a reason to widen the
tolerance.

## Node vs. real browser boundary

`apps/web/src/wasm/nodeWasmRender.mjs` is a **Node-only proof**: it drives the
same vendored `openscad.js`/`openscad.wasm` bytes and the same
`paramsToDefineArgs`/argv the browser worker uses, but it does not run inside a
real page and makes **no claim of browser numeric agreement**. The real-browser
app-load / preview / Params / History checks are a separate manual exercise
owned by the project lead. A passing Node run is never reported as browser
evidence.
