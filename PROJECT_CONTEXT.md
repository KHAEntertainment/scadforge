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

## Verification Gate
The gate every PR head must pass before QA, review or merge. QA lanes run it exactly as written. A command that fails, or that did not run, fails the gate.

Run from the worktree root, in this order. Each command must exit 0:

1. `pnpm install --frozen-lockfile`
2. `pnpm -r build`
3. `pnpm -r test`. The Docker daemon must be up so every `@docker` suite executes. A skipped `@docker` suite counts as not run.
4. `pnpm lint`
5. `node scripts/check-licenses.mjs`

**Evidence rules**
- Report each command with its exit code, from one final run at the head being reported. A result carried over from an earlier commit, or from a partial re-run, is not evidence.
- Report per-package test counts, including executed and skipped `@docker` counts. Keep the test output unfiltered: a filter that drops Vitest's summary lines hides skips.
- After any fix, re-run the whole gate, not only the check that failed.

**CI also runs these** (`.github/workflows/ci.yml`). Run them locally when a change touches the license gate, the Docker image or the M2 integration path:
- `node scripts/check-licenses.mjs --self-test`
- `node scripts/check-licenses.e2e.mjs`. It temporarily injects a GPL dependency and edits `package.json` and `pnpm-lock.yaml`, then reverts. Never run it in a read-only lane.
- `bash docker/ci-smoke-render.sh` (pinned image build plus a smoke render)
- `node evals/scenario-a2/run.mjs --no-compose` (M2 parameter and preview agreement)

**Shared host**
- Only one full `pnpm -r test` runs on a machine at a time; parallel Docker suites overload the host.
- Serialize runs with a lock directory, `$HOME/.scadforge-suite.lock`. Its `owner` file holds the holder's agent id and a UTC timestamp.
- Hold the lock only for the test run, never while editing, and always release it.
- Report a lock whose owner is older than 45 minutes to the Tech Lead rather than breaking it.
- A single non-Docker test file (`pnpm --filter <package> exec vitest run <file>`) needs no lock.

**Known flake**
- Issue #83: the same-key test in `apps/server/src/services/params-update.docker.test.ts` can time out under host load.
- If it is the only failure, re-run that one file once and report both results.
- Any other failure is a real failure.

**Docs-only changes** (Markdown or comment lines only; no code, configuration or lockfile change) run `pnpm lint` and `node scripts/check-licenses.mjs`. The full suite is not required.

## Spike Decisions (Round-0 close, 2026-08-26 — all four spikes GO or GO-WITH-CAVEATS)
- **OpenSCAD pin**: `docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7` → OpenSCAD **2026.01.19** (git e43242666), official weekly CI image, multi-arch (native arm64). AppImage-in-Docker rejected (x86 nightly segfaults under QEMU on Apple Silicon; arm64 AppImage too old; source build OOMs). Caveat: trails newest x86-only nightly ~5 weeks — recheck tags if a newer feature becomes load-bearing.
- **render_views camera constants** (frozen into contract): common flags `--viewall --autocenter --projection=ortho --imgsize=1024,768 --backend=Manifold --render --colorscheme=Cornfield`; rotations iso `55,0,25`, front `90,0,0`, top `0,0,0`, right `90,0,90`. Verified: 3MF color export ✓, `--export-format=param` ✓, byte-identical determinism ✓, ~3.7s per 5-view set.
- **Section view**: two-pass — export mesh, then wrapper with `import()` + `difference()`. The SDP §6.2 single-pass `difference(){ include ... }` sketch DOES NOT PARSE (include is rejected in nested scopes).
- **WASM preview (M2)**: binary STL (`--export-format=binstl`) + three.js `STLLoader` (3MF compiled out of the wasm build; STL carries no color — server renders remain color authority). **Re-instantiate the module per render** inside one long-lived worker (`callMain` reuse aborts / leaks ~3.4GB). The spike measured ~1.6s/render and stable heap; its 12.7s uncached initialization included 56 BOSL2 fetches. M2 now bundles those sources into the worker; the old cold-start figure is historical, not a current benchmark.
- **validate_mesh input**: parallel binary-STL export (zero-dep parse), NOT 3MF parsing — `openscad -o out.3mf -o out.stl` emits both in one render. `ValidationReport = {manifold, status, volume_mm3, surface_area, bbox, triangle_count, components, genus}`; `genus` meaningful only when `components === 1`. Gates: manifold hard, volume > 0.001 hard, components === 1 hard with `allowMultiPart` override. Use manifold-3d for manifoldness (hand-rolled edge-pairing gives false positives on CGAL unions).
- **Agent SDK (M1 #13 requirements)**: pin `@anthropic-ai/claude-agent-sdk` **exactly 0.3.246** (zod ^4; caret ranges hit a fatal duplicate-tool_use-id bug); always `settingSources: []` (omitting it leaks operator ~/.claude config, 210× tokens) and `tools: []` (else MCP tools defer behind ToolSearch); real usage only via `message_delta` with `includePartialMessages: true`; tool-result images = MCP CallToolResult `{type:'image', data:<base64>, mimeType:'image/png'}` with a text label block before each image; NEVER `isError:true` on results carrying images (content collapses to string); pass budget enforced in the write_scad tool handler (not maxTurns) so mcp-server inherits it; "no .scad in chat" enforced host-side by stripping fenced blocks from assistant_text; SDK makes an auxiliary ~900-token haiku call per run (known cost constant). Cost: ~$0.08 single-pass turn, ~$0.14 two-pass; latency dominated by OpenSCAD, not the model.
- **Agent SDK strict MCP isolation (Issue #75)**: also mandatory, always `strictMcpConfig: true` (maps to the CLI's `--strict-mcp-config`) — `settingSources: []` does NOT stop the bundled CLI from loading the OPERATOR's entire `~/.claude.json` MCP server list on top of the in-process `scadforge` server; measured before the fix at 12 attempted `claude.ai …` connectors, ~280 held connections and 157K cache-creation tokens (~$1.57) for their tool schemas on one trivial turn, ~0 (verified <20 established connections on a live turn) after. `createRealAgentProvider` (`apps/server/src/services/agent-impl.ts`) also wires the CLI's stderr — previously discarded entirely — to the server's stderr: one write per stderr chunk (never one per line), lines prefixed with the turn id, buffered per turn id (`chat.ts` locks per project, so concurrent turns on different projects share the forwarder and must not bleed into each other's lines), and never throwing (a failed write, e.g. `EPIPE`, is dropped and logged at most once per turn). `SCADFORGE_AGENT_STDERR=0` disables it, default enabled.

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

### M2 Parametric + Live (integration issue #35 closed)
- [x] Customizer parameter parser (#30, PR #38), params plumbing (#32, PR #43), params tab sliders (#33, PR #46)
- [x] WASM preview worker with server-authority fallback (#31, PR #39)
- [x] History tab: list, diff, revert (#34, PR #42)
- [x] Stabilization: web/API transport (PR #37), timer binding (PR #49), snapshot mesh persistence (PR #50), immutable snapshots (PR #51), studio params and narrow-pane layout (PR #57)
- [x] Debt closed 2026-09-10: orphaned snapshot claims (#28, PR #58), CRLF ingest (#40, PR #59), exports ledger lock (#48, PR #60), license gate hardening (#10, PR #61)

### S2 Measure / Inspect
- [x] Measurement overlay: bbox dimensions and face-to-face axis (PR #62), edge-anchored hybrid with camera-aware pick (PR #65)
- [x] Cylindrical surface inspection with measured provenance (PR #67)

### S3-A Editor contract
- [x] Additive frozen contract: editor module, D7 agent context, disk manifests (PR #71, merged 2026-09-13)

### S3-B Crash-recoverable store and editor routes (stage PR #130, merged 2026-11-22, 18 ticket PRs)
- [x] Canonical JSON, digests and the editor revision (B1, PR #74)
- [x] Recovery boundary and stale-lock reclaim (B2, PR #80)
- [x] `editor.json` sidecar captured with each snapshot (B3, PR #88)
- [x] Staged roll-forward transactions with durable operation claims (B4, PR #96)
- [x] Proof service and verify route (B5, PR #97)
- [x] Editor routes, command handler, undo/redo traversal (B6, PR #108)
- [x] Agent editor context in `read_project` (B7, PR #95)
- [x] Fault qualification crash matrix (B8, PRs #103, #112, #122)
- [x] Contract fixes through dedicated PRs: editor `projectId` accepts project slugs (#93, PR #94); `SnapshotOrigin` gains `"editor"` (#104, PR #105)
- [x] File-lock reclaim race found by the stage review (#128, PR #129)

## S3-B store facts (binding on later work)
- **Recovery first**: every project access goes through the recovery boundary (`withRecoveredProject`). It rolls an interrupted transaction forward before anything reads or writes.
- **Atomic publish**: source, params, head and the `editor.json` sidecar are staged under `editor-transactions/` and publish together or not at all. Durable operation claims make a repeated commit idempotent.
- **Upgrade in place**: the first write through an S3-B build adds `editor.json`, `editor-transactions/` and `editor_store_version: 1` in `project.json`. A build from before S3-B can still read a clean upgraded project.
- **No downgrade with mixed writers**: a pre-S3-B build never processes `editor-transactions/` and its snapshot and revert paths ignore sidecars. Never open a project that has an interrupted transaction with an older build.
- **File locks** (`packages/scad-core/src/store/file-lock.ts`): the published `owner.json` decides who holds a lock. Publication uses a hard link, so a filesystem without hard-link support (exFAT, some network shares) fails every lock acquisition closed. Locks are same-host only; a lock owned by another host is never reclaimed.
- **Open advisories on the lock tests**: three settle windows and one load-sensitive "two adopters" test in `file-lock.reclaim-race.test.ts` (see the review on PR #129). Fold them into the #121 timeout sweep.

## M1 empirical findings (binding on later work)
- **OpenSCAD CLI**: base image has NO ENTRYPOINT — always name `openscad` explicitly. `--export-format` applies to EVERY `-o` target in one invocation (a naive `-o out.3mf -o out.stl --export-format=binstl` writes STL bytes into the .3mf) — use two invocations for non-STL formats. Bare `--render` is swallowed by boost::program_options when last before the positional path — always `--render=true`. Library mount convention: libs at `/work/libs` + `OPENSCADPATH=/work/libs`.
- **Snapshot store concurrency**: ids are claimed by atomic non-recursive `mkdir` + EEXIST retry, which is safe ACROSS PROCESSES (required for M4, where GUI server and MCP server share one `.scadforge/` tree). Typed `CONFLICT` (→409) on exhaustion; never a silent overwrite. Open edge case: #28 (SIGKILL between claim and cleanup orphans a claim dir).
- **Path→URL seam**: `artifactUrl`/`exportFileName`/`readImageBase64` are implemented host-side in `apps/server`; `packages/agent` stays HTTP-free (required for the M4 stdio MCP host) and GPL-free (the GPL `packages/libs` binding lives in the server).
- **Model cost**: `SCADFORGE_MODEL` unset → SDK defaults to Opus; a single-pass Scenario A turn cost **$0.97** vs Spike 3's $0.08–0.14 on a cheaper model. Set the default explicitly before the M3 eval harness runs 10–20 prompts per change.
- **Contract friction logged (no frozen edits)**: (1) `ChatTurnRequest.images` has no path into the agent — text-only in M1, needed for v2 photo input; (2) `ToolResultEvent` is summary-only so SSE consumers can't read a `ValidationReport` from the stream (harness reads the persisted manifest); (3) `writeScadResultSchema` can't express a failed syntax check (superset workaround parses); (4) no error code distinguishes green-validation early-stop from genuine `PASS_BUDGET_EXHAUSTED`.

## External Review Policy (owner decision 2026-09-13)
- **Mode**: `off`. CodeRabbit on the current free plan posts a walkthrough comment but never submits a formal review, so a review-completion gate keyed on it can never clear (observed on PRs #71, #74, #80, #81).
- **Substitute**: every PR gets an internal read-only QA lane plus an independent read-only review lane with distinct agent identities before the Tech Lead rates it. Neither lane may hold implementation ownership. CodeRabbit's walkthrough is read as advisory context only.
- **Trusted / required / ignored reviewers**: none.
- Revisit if the CodeRabbit plan changes or a reviewer that submits formal reviews is adopted.

## Execution Routing Policy (revised 2026-11-23)
- **Source of truth**: the owner's global agent selection guide (`~/.traycer/agent-selection-guide.md`, v33 on 2026-11-22). This project sets no routes of its own. Where an older note here and the guide differ, the guide wins.
- **Routes the guide gave on 2026-11-22**, recorded as history, not as policy: independent review by Codex `gpt-6.1-sol`; difficult implementation by Claude Sonnet; standard implementation and QA by Pi `minimax/MiniMax-M3.1-Flash` at low reasoning; the reviewer is always a different model family from the author; at most three review rounds.
- **Superseded**: the 2026-09-13 routes (Nemotron review via OpenRouter, Claude Sonnet for all implementation, DeepSeek or Kimi for QA). The DeepSeek and Kimi routes failed on first use (402 insufficient balance; zero output).

## Current Status
- **Last updated**: 2026-11-23
- **On `main`**: M1, M2, the studio stabilization work, S2 measure and inspect, the S3-A editor contract and the whole S3-B stage (see Completed Features). The Verification Gate at `206c616` runs 1,674 tests with no skips: mcp-server 1, protocol 128, scad-core 642, agent 274, libs 25, web 356, server 248.
- **What S3-B means for a user**: nothing visible yet. It is the server side of direct editing. The first editor UI arrives with S3-C ticket C4.
- **Active integration work**: branch `feat/s3-c-transaction-controller`, cut from `main` at `206c616` on 2026-11-23. S3-C is the browser transaction controller: C1 editor client, C2 controller core (#113, PR #116), C3 undo/redo, C4 minimal Edit screen, C5 qualification. C1, C3, C4 and C5 have plan artifacts but no GitHub issues yet. #70 (second-tab notice) follows C4.
- **Open gate before S4-B**: the S0 / D1 qualification on a second device and one real user project. It needs the owner.
- **Design gate**: #52 requires an owner-led conversation and generative-UI design session before any chat-transcript work. Chat still uses tab-scoped sessionStorage, not a durable project transcript. M4 MCP serving remains a placeholder.
- **Known tech debt**: #83 flaky same-key slider-drag test under Docker load; #86 agent stderr chunk arriving after a turn ends; #121 timeout floor for the remaining Docker-shelling server tests; four files carry a duplicate SPDX line; a duplicated heading in the `file-lock.ts` header; explicit model default (see the cost finding above).
- **Backlog outside the S3 / S4 line**: #63 click an edge to measure, #64 point-to-point measure, #66 feature-semantic dimensions.
- **Removed**: the Reticle dev-tool audition (added by PR #89) was removed by PR #132. Do not re-run `reticle init` in this repo.
