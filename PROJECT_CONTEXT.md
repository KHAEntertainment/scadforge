# PROJECT_CONTEXT

## Repository Info
- **Repo URL**: https://github.com/KHAEntertainment/scadforge
- **Main branch**: main
- **Created**: 2026-08-25

## Tech Stack
- **Language**: TypeScript (Node 22)
- **Monorepo**: pnpm workspaces (`apps/web`, `apps/server`, `packages/*`); `spikes/` is EXCLUDED from the workspace (standalone throwaway packages)
- **Frontend**: Vite + React + TypeScript; three.js via `@react-three/fiber` + drei; Monaco editor; Konva annotate overlay (Round 3)
- **Server**: Hono on Node 22; SSE for agent event streaming
- **Agent**: Claude Agent SDK (TypeScript) behind a `ModelProvider` seam in `packages/agent`
- **Server CAD**: OpenSCAD nightly CLI, pinned build in Docker — **pin: TBD (decided by Spike 2, Issue #4)**
- **Browser CAD**: openscad-wasm in a Web Worker (Round 2; GPL zone `apps/web/src/wasm/**` only)
- **Mesh validation**: manifold-3d (npm/WASM, Apache-2)
- **Database**: **None** — filesystem project store (`.scadforge/` per project folder). Do not introduce a database.
- **Test framework**: Vitest (container-dependent tests tagged `@docker`)

## Architecture Decisions
- **Auth scheme**: **None** (local-first, single user, BYO API key via env). Do not introduce auth.
- **API spec**: REST + SSE. Error format `{"error_code": "...", "message": "..."}`. No pagination in v1.
- **SSE event union**: defined in `packages/protocol` (frozen by Issue #10): `turn_started, tool_call, tool_result, snapshot_created, assistant_text, turn_done, error`
- **Database migration framework**: None (no DB)
- **API Contract doc**: contracts live as TypeScript types + zod schemas in `packages/protocol`, `packages/scad-core/src/types.ts`, `packages/agent/src/tools/contract.ts` — these are the canonical API contract (no separate API_CONTRACT.md)
- **Agent tools (7, shared Agent SDK + MCP)**: `read_project, write_scad, set_params, render_views, validate_mesh, export, library_lookup`
- **Agent loop**: max **2 autonomous self-correction passes** per user turn (`SCADFORGE_MAX_PASSES`), stop early on green validation
- **Render authority**: server CLI render is authoritative; WASM preview is convenience only and must degrade gracefully
- **License**: GPL-3.0-or-later repo-wide. **GPL-free packages (Apache-2.0 headers): `packages/agent`, `packages/scad-core`, `packages/protocol`, `packages/mcp-server`.** GPL-derived code (openscad-playground ports, openscad-wasm glue) allowed ONLY under `apps/web/src/wasm/**`. CI license gate: `scripts/check-licenses.mjs`.

## Code Style Conventions
- **Naming**: TypeScript camelCase for values, PascalCase for types/components, kebab-case file names (React components PascalCase.tsx)
- **Directory structure**:
  ```
  apps/web/src/         components/, wasm/ (GPL zone), lib/
  apps/server/src/      routes/ (ONE ROUTE FILE PER RESOURCE), services/
  packages/protocol/    types-only, zero runtime deps
  packages/scad-core/   src/types.ts (frozen), params/, store/, validate/, runner/
  packages/agent/       src/tools/contract.ts (frozen), prompts/, provider/
  packages/mcp-server/  stdio binary
  packages/libs/        vendored BOSL2/MCAD + lookup index
  spikes/               standalone, NOT in workspace, never imported by product code
  ```
- **Error handling**: route layer returns `{error_code, message}`; no business logic in routes; external calls (OpenSCAD subprocess, filesystem) always wrapped with timeout + typed error
- **Contract freeze rule**: after their freeze issue merges, `packages/protocol/**`, `packages/scad-core/src/types.ts`, `packages/agent/src/tools/contract.ts` are Tech-Lead-owned. Workers must not edit them inside feature PRs — request changes via issue comment.
- **Agent output contract**: never paste full `.scad` into chat; short summaries only.

## Spike Decisions (filled at Round-0 close)
- **OpenSCAD nightly pin (date + digest)**: TBD — Spike 2 (#4)
- **WASM output format + three.js loader**: TBD — Spike 1 (#3)
- **WASM instance reuse vs re-instantiation**: TBD — Spike 1 (#3)
- **validate_mesh input format (3MF parse vs parallel STL export)**: TBD — Spike 4 (#6)
- **render_views camera constants**: TBD — Spike 2 (#4)

## Completed Features
- (none yet — Round 0 in progress)

## Current Status
- **Last updated**: 2026-08-25
- **Current iteration goal**: M0 Bootstrap + Spikes — monorepo scaffold (#2) and 4 de-risking spikes (#3–#6) as a parallel 5-worker wave; Round-0 close = Architecture Decision Checkpoint fills the Spike Decisions section above
- **Execution plan**: `~/.claude/plans/greenfield-project-ai-scad-is-delegated-coral.md` (approved 2026-08-25); milestones M0–M4
- **Known tech debt**: none
- **Open PRs**: none
