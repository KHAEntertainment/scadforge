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
- **Server CAD**: OpenSCAD 2026.01.19 CLI, pinned by Docker digest (see Spike Decisions below)
- **Browser CAD**: openscad-wasm in a Web Worker (Round 2; GPL zone `apps/web/src/wasm/**` only)
- **Mesh validation**: manifold-3d (npm/WASM, Apache-2)
- **Database**: **None** — filesystem project store (`.scadforge/` per project folder). Do not introduce a database.
- **Test framework**: Vitest (container-dependent tests tagged `@docker`)

## Architecture Decisions
- **Auth scheme**: **None** (local-first, single user, BYO API key via env). Do not introduce auth.
- **API spec**: REST + SSE. Error format `{"error_code": "...", "message": "..."}`. No pagination in v1.
- **SSE event union**: defined in `packages/protocol` (FROZEN — Issue #13, PR #21, merged 2026-08-26): `turn_started, tool_call, tool_result, snapshot_created, assistant_text, turn_done, error`
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
- **WASM preview (M2)**: binary STL (`--export-format=binstl`) + three.js `STLLoader` (3MF compiled out of the wasm build; STL carries no color — server renders remain color authority). **Re-instantiate the module per render** inside one long-lived worker (`callMain` reuse aborts / leaks ~3.4GB). The spike measured ~1.6s/render and stable heap; its 12.7s uncached initialization included 56 BOSL2 fetches. M2 now bundles those sources into the worker; the old cold-start figure is historical, not a current benchmark.
- **validate_mesh input**: parallel binary-STL export (zero-dep parse), NOT 3MF parsing — `openscad -o out.3mf -o out.stl` emits both in one render. `ValidationReport = {manifold, status, volume_mm3, surface_area, bbox, triangle_count, components, genus}`; `genus` meaningful only when `components === 1`. Gates: manifold hard, volume > 0.001 hard, components === 1 hard with `allowMultiPart` override. Use manifold-3d for manifoldness (hand-rolled edge-pairing gives false positives on CGAL unions).
- **Agent SDK (M1 #13 requirements)**: pin `@anthropic-ai/claude-agent-sdk` **exactly 0.3.246** (zod ^4; caret ranges hit a fatal duplicate-tool_use-id bug); always `settingSources: []` (omitting it leaks operator ~/.claude config, 210× tokens) and `tools: []` (else MCP tools defer behind ToolSearch); real usage only via `message_delta` with `includePartialMessages: true`; tool-result images = MCP CallToolResult `{type:'image', data:<base64>, mimeType:'image/png'}` with a text label block before each image; NEVER `isError:true` on results carrying images (content collapses to string); pass budget enforced in the write_scad tool handler (not maxTurns) so mcp-server inherits it; "no .scad in chat" enforced host-side by stripping fenced blocks from assistant_text; SDK makes an auxiliary ~900-token haiku call per run (known cost constant). Cost: ~$0.08 single-pass turn, ~$0.14 two-pass; latency dominated by OpenSCAD, not the model.

## Completed Features
- [x] Monorepo scaffold + CI + license gate (Issue #2, PR #8, merged 2026-08-26)
- [x] Spike 1 openscad-wasm (Issue #3, PR #9, GO)
- [x] Spike 2 OpenSCAD docker pin + view harness (Issue #4, PR #11, GO-WITH-CAVEATS)
- [x] Spike 3 Agent SDK loop (Issue #5, PR #12, GO-WITH-CAVEATS)
- [x] Spike 4 manifold-3d validation (Issue #6, PR #7, GO)

### M1 Core Loop (milestone closed 2026-08-27, 8/8 issues)
- [x] Interface contracts FROZEN — protocol, scad-core types, 7 tool schemas (#13, PR #21)
- [x] scad-core runtime — CLI runner, project store, validation, export (#14, PR #27)
- [x] Pinned OpenSCAD docker image + compose + CI smoke render (#15, PR #22)
- [x] Agent runtime — ModelProvider seam, prompts, tool handlers, 2-pass loop (#16, PR #26)
- [x] Server — Hono routes, SSE, DI seams (#17, PR #25)
- [x] Web shell — chat, three.js viewer, snapshots, export (#18, PR #23)
- [x] libs — vendored BOSL2/MCAD + 1175-symbol lookup index (#19, PR #24)
- [x] Integration + **Scenario A end-to-end 6/6** (#20, PR #29)

## M1 empirical findings (binding on later work)
- **OpenSCAD CLI**: base image has NO ENTRYPOINT — always name `openscad` explicitly. `--export-format` applies to EVERY `-o` target in one invocation (a naive `-o out.3mf -o out.stl --export-format=binstl` writes STL bytes into the .3mf) — use two invocations for non-STL formats. Bare `--render` is swallowed by boost::program_options when last before the positional path — always `--render=true`. Library mount convention: libs at `/work/libs` + `OPENSCADPATH=/work/libs`.
- **Snapshot store concurrency**: ids are claimed by atomic non-recursive `mkdir` + EEXIST retry, which is safe ACROSS PROCESSES (required for M4, where GUI server and MCP server share one `.scadforge/` tree). Typed `CONFLICT` (→409) on exhaustion; never a silent overwrite. Open edge case: #28 (SIGKILL between claim and cleanup orphans a claim dir).
- **Path→URL seam**: `artifactUrl`/`exportFileName`/`readImageBase64` are implemented host-side in `apps/server`; `packages/agent` stays HTTP-free (required for the M4 stdio MCP host) and GPL-free (the GPL `packages/libs` binding lives in the server).
- **Model cost**: `SCADFORGE_MODEL` unset → SDK defaults to Opus; a single-pass Scenario A turn cost **$0.97** vs Spike 3's $0.08–0.14 on a cheaper model. Set the default explicitly before the M3 eval harness runs 10–20 prompts per change.
- **Contract friction logged (no frozen edits)**: (1) `ChatTurnRequest.images` has no path into the agent — text-only in M1, needed for v2 photo input; (2) `ToolResultEvent` is summary-only so SSE consumers can't read a `ValidationReport` from the stream (harness reads the persisted manifest); (3) `writeScadResultSchema` can't express a failed syntax check (superset workaround parses); (4) no error code distinguishes green-validation early-stop from genuine `PASS_BUDGET_EXHAUSTED`.

## Current Status
- **Last updated**: 2026-09-08
- **M0 core deliverables and M1 complete.** M0 still has license-gate debt #10. Scenario A was rerun unchanged on 2026-09-08: 6/6 assertions passed with one explicit Sonnet turn; evidence is under `evals/scenario-a/evidence/`. The baseline workspace suite passed 790 tests, including Docker suites.
- **M2 Parametric + Live features merged**: Customizer parser (#38), WASM preview (#39), params plumbing (#43), controls (#46), History diff/revert (#42). BOSL2 source files are bundled into the preview worker at build time. Closing integration issue #35 is in progress; feature merges alone do not establish preview/server agreement.
- **Stabilization merged**: web/API transport (#37), timer binding (#49), snapshot mesh persistence and user prompt echo (#50), immutable history and concurrent parameter updates (#51). Later render/validation artifacts live under `.scadforge/derived/<id>/`; old snapshot directories stay write-once.
- **Next boundary**: complete M2 integration/stability, then reassess functionality and hold a dedicated UI/UX design phase. Issue #52 explicitly requires owner-led conversation/generative-UI design before implementation and before M3 annotation. Current chat uses tab-scoped sessionStorage, not a durable project transcript. M4 MCP serving remains a placeholder.
- **Known tech debt**: #10 license-gate hardening; #28 orphaned snapshot claim dir; #40 systemic LF normalization; #48 export-index concurrency; explicit model default (see cost finding above). These are not silently included in M2 closure.
- **Active integration work**: branch `traycer/scadforge-ripe-elk`; final review and PR CI are required before closing #35.
