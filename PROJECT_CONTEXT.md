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

## Spike Decisions (Round-0 close, 2026-08-26 — all four spikes GO or GO-WITH-CAVEATS)
- **OpenSCAD pin**: `docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7` → OpenSCAD **2026.01.19** (git e43242666), official weekly CI image, multi-arch (native arm64). AppImage-in-Docker rejected (x86 nightly segfaults under QEMU on Apple Silicon; arm64 AppImage too old; source build OOMs). Caveat: trails newest x86-only nightly ~5 weeks — recheck tags if a newer feature becomes load-bearing.
- **render_views camera constants** (frozen into contract): common flags `--viewall --autocenter --projection=ortho --imgsize=1024,768 --backend=Manifold --render --colorscheme=Cornfield`; rotations iso `55,0,25`, front `90,0,0`, top `0,0,0`, right `90,0,90`. Verified: 3MF color export ✓, `--export-format=param` ✓, byte-identical determinism ✓, ~3.7s per 5-view set.
- **Section view**: two-pass — export mesh, then wrapper with `import()` + `difference()`. The SDP §6.2 single-pass `difference(){ include ... }` sketch DOES NOT PARSE (include is rejected in nested scopes).
- **WASM preview (M2)**: binary STL (`--export-format=binstl`) + three.js `STLLoader` (3MF compiled out of the wasm build; STL carries no color — server renders remain color authority). **Re-instantiate the module per render** inside one long-lived worker (`callMain` reuse aborts / leaks ~3.4GB). ~1.6s/render, stable heap; cold-init 12.7s uncached dominated by 56-file BOSL2 fetch (bundle-packaging fix queued for M2).
- **validate_mesh input**: parallel binary-STL export (zero-dep parse), NOT 3MF parsing — `openscad -o out.3mf -o out.stl` emits both in one render. `ValidationReport = {manifold, status, volume_mm3, surface_area, bbox, triangle_count, components, genus}`; `genus` meaningful only when `components === 1`. Gates: manifold hard, volume > 0.001 hard, components === 1 hard with `allowMultiPart` override. Use manifold-3d for manifoldness (hand-rolled edge-pairing gives false positives on CGAL unions).
- **Agent SDK (M1 #13 requirements)**: pin `@anthropic-ai/claude-agent-sdk` **exactly 0.3.246** (zod ^4; caret ranges hit a fatal duplicate-tool_use-id bug); always `settingSources: []` (omitting it leaks operator ~/.claude config, 210× tokens) and `tools: []` (else MCP tools defer behind ToolSearch); real usage only via `message_delta` with `includePartialMessages: true`; tool-result images = MCP CallToolResult `{type:'image', data:<base64>, mimeType:'image/png'}` with a text label block before each image; NEVER `isError:true` on results carrying images (content collapses to string); pass budget enforced in the write_scad tool handler (not maxTurns) so mcp-server inherits it; "no .scad in chat" enforced host-side by stripping fenced blocks from assistant_text; SDK makes an auxiliary ~900-token haiku call per run (known cost constant). Cost: ~$0.08 single-pass turn, ~$0.14 two-pass; latency dominated by OpenSCAD, not the model.

## Completed Features
- [x] Monorepo scaffold + CI + license gate (Issue #2, PR #8, merged 2026-08-26)
- [x] Spike 1 openscad-wasm (Issue #3, PR #9, GO)
- [x] Spike 2 OpenSCAD docker pin + view harness (Issue #4, PR #11, GO-WITH-CAVEATS)
- [x] Spike 3 Agent SDK loop (Issue #5, PR #12, GO-WITH-CAVEATS)
- [x] Spike 4 manifold-3d validation (Issue #6, PR #7, GO)

## Current Status
- **Last updated**: 2026-08-26
- **M0 complete.** All spikes GO; Architecture Decision Checkpoint recorded above.
- **Current iteration goal**: M1 Core Loop — contract freeze first, then 6-worker parallel wave, closing with Scenario A end-to-end
- **Execution plan**: `~/.claude/plans/greenfield-project-ai-scad-is-delegated-coral.md` (approved 2026-08-25)
- **Known tech debt**: #10 license-gate hardening (peerDependencies + real pnpm-list CI path); BOSL2 56-file fetch packaging (M2); prod validate_mesh needs clean malformed-input errors (QA finding, fold into scad-core issue)
- **Open PRs**: none
