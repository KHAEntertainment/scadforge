# ScadForge — Software Design & Development Plan (SDP)
**Working title:** ScadForge (placeholder — rename freely)
**Owner:** Billy Brenner
**Status:** v0.1 — brainstorm output, ready to seed a Claude Code project
**Date:** 2026-08-26

---

## 1. Thesis

Frontier LLMs are already good at writing OpenSCAD from plain-English instructions. The missing piece is not a better 3D model; it is a *loop*: a place where the model can see what it built, the human can point at what's wrong, and the result comes out as a parametric, print-ready part rather than a frozen mesh.

ScadForge is a local-first, Lovable-style builder whose output is an OpenSCAD project instead of a web app. The user talks; the agent writes `.scad`; the app renders it in the browser and on the server; the agent inspects its own renders and validates the mesh; the user annotates the preview to steer; the app exports a validated 3MF. The same tool loop is exposed as an MCP server so Claude Code can drive a ScadForge project without the GUI.

We are deliberately **not** using text-to-3D generative models (Tripo, etc.). Code is the interface. Two shipping products (ModelRift, GrandpaCAD) independently arrived at OpenSCAD + BOSL2 after trying JSON schemas, JSCAD, Blender's Python API, and CadQuery/build123d, for the same reasons we would: declarative, token-efficient, sandboxable, and heavily represented in training data.

## 2. Goals and non-goals

### v1 goals

1. Natural-language → OpenSCAD with a 1–2 pass agent self-correction loop (render → look → fix → hand back).
2. Instant in-browser preview via openscad-wasm, with auto-generated **Customizer sliders** from agent-written parameters.
3. **Annotate-on-render**: draw arrows/boxes/labels on the preview, send the annotated image (plus camera pose) back to the agent.
4. **Version history + diff** for every agent turn, with one-click revert.
5. **Mesh validation** in the loop (manifold, volume, bounding box, basic printability heuristics) so exports are actually print-ready.
6. **3MF export** (colors preserved) suitable for MakerWorld and slicers; STL as a secondary.
7. **MCP server** exposing the same write/render/validate/export tools to Claude Code.
8. Runs locally via `docker compose up` (or a single `npx` entry point later) with a bring-your-own API key.

### Non-goals for v1 (designed for, not built)

- Multi-provider model switching (Gemini/OpenAI). Build the seam; ship Claude only.
- **Photo analysis for idea input / recreating a physical item from a photo.** Explicit v2 item; v1 architecture must not preclude image inputs to the agent (it won't — the Agent SDK accepts images natively).
- Accounts, sharing, hosting, billing.
- Image-to-mesh, STEP export, animation rendering, library management beyond bundled BOSL2/MCAD.

## 3. Users and core scenarios

**Primary user (v1):** Billy and makers like him — people who design functional prints for MakerWorld, know roughly what they want, can read code if needed but would rather not write it, and care that the part is parametric and printable.

**Scenario A — from scratch.** "A wall-mount bracket for a 32 mm pipe with two M4 screw slots." Agent writes the model with `pipe_d`, `wall`, `slot_len`, `screw_d` as Customizer parameters; server renders iso/front/top/section; agent notices the slots pierce the back wall, fixes it, hands back. User drags `wall` from 3 to 4 mm and watches the WASM preview update. Exports 3MF.

**Scenario B — steer with annotation.** User hits Annotate, draws an arrow on the iso view, types "chamfer this edge," sends. Agent receives the composite PNG + `{view: "iso", camera: {...}}`, edits the code, re-renders, hands back. History shows the diff.

**Scenario C — from Claude Code.** In a terminal, Claude Code (with the ScadForge MCP server attached) iterates on the same project folder. The GUI, if open, reflects the new snapshot.

**Scenario D (v2) — from a photo.** User uploads a photo of a broken drawer pull and a reference dimension. Agent proposes a spec (dimensions, features), user confirms, agent generates the model.

## 4. Architecture (hybrid)

```
┌────────────────────────────── Browser (apps/web) ──────────────────────────────┐
│  Chat panel ── Preview (three.js) ── Code (Monaco) ── Params (sliders) ── History │
│        │              ▲   │  Annotate (Konva/Fabric overlay)                     │
│        │              │   └── screenshot+camera pose ──────────────┐             │
│        │       Web Worker: openscad-wasm (instant preview, params) │             │
└────────┼───────────────────────────────────────────────────────────┼─────────────┘
         │ SSE / WebSocket (agent events, snapshots)                 │
┌────────▼───────────────────────────────────────────────────────────▼─────────────┐
│                          Node service (apps/server)                              │
│  Agent runtime (Claude Agent SDK, TS)  ── tools ──►  scad-core                   │
│     write_scad / read_scad / render_views / validate_mesh / export / params       │
│  Project store (.scadforge/ on disk, snapshots, diffs)                            │
│  OpenSCAD nightly CLI (subprocess, sandboxed tmp dir)  ── PNG views, 3MF/STL     │
│  manifold-3d (WASM) ── mesh validation                                           │
│  MCP server (packages/mcp-server) ── same tools, stdio transport for Claude Code │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Why hybrid.** The browser owns everything interactive (orbit, sliders, annotate) and needs zero round-trips for it. The server owns everything the *agent* depends on: deterministic multi-view renders with fixed cameras, mesh validation, and export. The agent never depends on what the user's browser can render, and the same server tools power the MCP surface. ModelRift's benchmark lesson — "preview and export are not the same thing" — is why validation runs on the exported mesh, not on a screenshot.

**Single source of truth.** One project folder on disk. Both the WASM preview and the CLI render read the same `model.scad` + `params.json`.

## 5. Tech stack (decided)

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo (optional) | `apps/web`, `apps/server`, `packages/*` |
| Frontend | Vite + React + TypeScript | Borrow patterns/code from `openscad/openscad-playground` (Monaco setup, customizer parser, worker wiring). Respect its license. |
| 3D view | three.js (`@react-three/fiber` + drei `OrbitControls`) | Preferred over `<model-viewer>` because annotation overlay and camera-pose capture need direct camera access. |
| Editor | Monaco with OpenSCAD language config | Lift from playground. |
| Annotate | Konva (or Fabric.js) overlay on a frozen frame of the three.js canvas | Output: composite PNG + view name + camera pose JSON. ModelRift reports this took weeks; budget accordingly. |
| Browser CAD | `openscad-wasm` (official build) in a Web Worker | New instance per render (verify whether `callMain` can be reused; playground behavior suggests re-instantiation). Pass `--backend=manifold` (nightly flag; `--enable=manifold` on older builds). |
| Server | Node 22 + Hono (or Fastify) + TypeScript | SSE for agent event streaming; WebSocket only if bidirectional need appears. |
| Agent | **Claude Agent SDK (TypeScript)** | Custom tools via `createSdkMcpServer` / `tool()`; that same definition is reused for the external MCP server. |
| Provider seam | `ModelProvider` interface in `packages/agent` | v1 impl: Agent SDK. v2 impl: Vercel AI SDK (multi-provider). Tools and prompts are provider-agnostic. |
| Server CAD | OpenSCAD **nightly** (pinned build in Docker) | Stable 2021.01 lacks manifold, color export, and newer language features. Pin a specific nightly date and record it. |
| Mesh checks | `manifold-3d` (npm/WASM, Apache-2) + three.js `BufferGeometry` utilities | Manifoldness, volume, surface area, bbox, genus; thin-wall heuristic later. |
| MCP | `@modelcontextprotocol/sdk` (TS), stdio transport | Package: `packages/mcp-server`, binary `scadforge-mcp`. |
| Storage | Filesystem (`.scadforge/`), no DB in v1 | Optional `git init` in the project folder; history is our own snapshot format either way. |
| Packaging | `docker compose` (server + OpenSCAD nightly image); web served by the Node service | Later: single `npx scadforge` that downloads a pinned OpenSCAD binary. |

## 6. Agent design

### 6.1 Loop

```
user message (+ optional annotated image / params)
  → agent: plan briefly, write_scad
  → tool: render_views  → returns {iso, front, top, section} PNGs + stderr + timings
  → tool: validate_mesh → returns {manifold, volume, bbox, triangles, warnings[]}
  → agent: inspect renders + validation; if defect found, fix and re-render (max 2 passes, configurable)
  → agent: hand back with a short summary + the parameters it exposed
  → server: snapshot (scad, params, renders, message, diff) → push to UI
```

Hard budget: **2 autonomous passes** per user turn by default (`SCADFORGE_MAX_PASSES`). The agent must stop early when validation is green and renders match the request. Every pass costs tokens *and* the risk of "improving" things the user didn't ask for.

### 6.2 Tools (shared between Agent SDK and MCP server)

| Tool | Input | Output |
|---|---|---|
| `read_project` | — | `model.scad`, `params.json`, current param schema, last validation |
| `write_scad` | full file contents (v1: whole-file writes; diff-edit later) | syntax check result (`openscad -o /dev/null --export-format=... ` or WASM parse), snapshot id |
| `set_params` | `{name: value}` | updated `params.json` |
| `render_views` | optional `views[]`, `imgsize`, `params` override | PNG paths/base64 for each view, OpenSCAD stderr, render time |
| `validate_mesh` | optional `params` override | `{manifold: bool, volume_mm3, surface_area, bbox, triangle_count, components, warnings[]}` |
| `export` | `format: "3mf" \| "stl" \| "off"`, `params` override | file path, size, validation summary |
| `library_lookup` | `query` (e.g. "BOSL2 screw_hole") | matching snippets from the bundled BOSL2/MCAD reference index |

`render_views` fixed camera set (all `--viewall --autocenter`, orthographic by default):
- `iso`: `--camera=0,0,0,55,0,25,0` style rotation view
- `front`, `top`, `right`: axis-aligned
- `section`: the model wrapped in `difference(){ include <model.scad>; half-space cube }` cut at the bbox center on Y — gives the agent a look at internal walls and holes. Implemented by generating a temporary wrapper `.scad`.

### 6.3 Prompting strategy

- System prompt: OpenSCAD idioms, the Customizer parameter syntax and section comments, "parameters first, helpers second, geometry last," `$fn` discipline, units in mm, BOSL2 usage guidance, and the explicit instruction to **inspect renders before declaring done** and to **treat validation warnings as blocking**.
- Context management: do not stuff BOSL2 docs into every prompt. Provide `library_lookup` over a pre-built index of BOSL2/MCAD signatures and examples.
- Annotation inputs arrive as an image block plus a text block: `View: iso. Camera: {...}. User wrote: "chamfer this edge".` The camera pose lets the model map the 2D arrow to 3D.
- Output contract: the agent returns a short natural-language summary and *never* pastes the full code into chat (the Code tab shows it). Keeps the chat readable and tokens down.

### 6.4 Provider seam (v2-ready)

```ts
interface ModelProvider {
  runTurn(input: TurnInput, tools: ToolSet, onEvent: (e: AgentEvent) => void): Promise<TurnResult>;
}
```

v1 ships `ClaudeAgentSdkProvider`. Prompts, tool schemas, and the event stream are provider-neutral so a `VercelAiSdkProvider` can slot in later without touching the UI or tools.

## 7. Rendering and validation pipeline

**Browser (preview).** Worker receives `{scad, params}` → writes to the Emscripten FS → `callMain(["/model.scad", "--backend=manifold", "-p", "/params.json", "-P", "current", "-o", "/out.<fmt>"])` → posts the mesh back → three.js displays it. Format preference: GLB (if the pinned WASM build exports it; preserves colors), else 3MF or OFF parsed client-side. Debounced ~300 ms on slider changes; a "Full render" button forces a fresh run.

**Server (agent eyes + export).** `openscad` nightly CLI in a per-request temp dir, args passed as an array (no shell), with a timeout (default 60 s; configurable) and memory limit inside the container. PNG views at 1024×768 with a fixed color scheme. Export to 3MF with `--export-format=3mf` (colors require manifold backend).

**Validation.** Load the exported mesh into `manifold-3d`: `Manifold.ofMesh(...)` → `status()`, `volume()`, `surfaceArea()`, `boundingBox()`, `genus()`; count connected components (a "bracket" that comes out as three islands is a bug). Later heuristics: thin walls under a threshold, unsupported overhangs summary, part exceeds a configured build volume.

**Customizer parameters.** Parse the Customizer comment syntax (`// [min:max]`, `// [a, b, c]`, `/* [Section] */`) to build the slider UI. Preferred path: the CLI's `--export-format=param` (nightly) to dump the parameter schema as JSON; fallback: port the parser from openscad-playground.

## 8. Project and history model

```
my-bracket/
  model.scad              # current model
  params.json             # current parameter values (Customizer preset format)
  .scadforge/
    project.json          # name, created, pinned openscad version, provider config
    history/
      0001/  message.md  model.scad  params.json  views/*.png  validation.json  diff.patch
      0002/  ...
    exports/  my-bracket-0002.3mf
```

Every agent turn and every manual save is a numbered snapshot. Diff = unified diff against the previous snapshot. Revert = copy snapshot files forward and create a new snapshot (history is append-only). Optional `git init` for users who want it; not required.

## 9. UI specification (v1)

- **Layout:** left chat column (≈35%), right workspace with tabs: **Preview** (default), **Code**, **Params**, **History**. Status strip shows last render time, validation badge (green/amber/red), and pinned OpenSCAD version.
- **Preview:** three.js orbit view; buttons for the fixed views (iso/front/top/right); "Annotate" toggles the overlay (arrow, rectangle, text, freehand); "Send" packages the composite + camera pose into the chat input.
- **Params:** auto-generated from the parameter schema; changes drive the WASM preview live and are persisted to `params.json`; "Ask agent to add a parameter" shortcut.
- **Code:** Monaco with OpenSCAD highlighting; manual edits create a snapshot on save; "Preview" runs WASM, "Validate" runs the server pipeline.
- **History:** list of snapshots with thumbnails, message excerpt, and validation badge; side-by-side diff; "Revert to this."
- **Exports:** 3MF (default), STL; export runs validation first and refuses (with override) on a red badge.

## 10. MCP server surface

`packages/mcp-server` wraps the same tool implementations over stdio. Project selection via `--project <path>` or `SCADFORGE_PROJECT`. Suggested `.mcp.json` entry:

```json
{ "mcpServers": { "scadforge": { "command": "npx", "args": ["scadforge-mcp", "--project", "."] } } }
```

Tools exposed: `read_project`, `write_scad`, `set_params`, `render_views` (returns images), `validate_mesh`, `export`, `library_lookup`. The GUI watches `.scadforge/history` so snapshots created from Claude Code appear live.

## 11. Repository layout

```
scadforge/
  apps/web/            Vite + React UI
  apps/server/         Hono service: agent runtime, project store, CLI wrapper, SSE
  packages/agent/      ModelProvider interface, ClaudeAgentSdkProvider, prompts, tool defs
  packages/scad-core/  customizer parser, scad wrapper generation (section cut), OpenSCAD CLI runner, validation
  packages/mcp-server/ stdio MCP binary reusing scad-core + tool defs
  packages/libs/       bundled BOSL2 + MCAD + lookup index build script
  docker/              OpenSCAD nightly image (pinned), compose file
  docs/                this SDP, ADRs, prompt library
```

## 12. Phased plan

**Phase 0 — Spikes (≈1 week).** De-risk the unknowns before building UI.
1. openscad-wasm in a Vite Web Worker: render a BOSL2 part, measure time and bundle size, confirm output format options and whether instances can be reused.
2. OpenSCAD nightly in Docker driven from Node: PNG views with fixed cameras, 3MF with colors, `--export-format=param`, timings on a mid-size model.
3. Claude Agent SDK with custom tools: one full write → render → validate → fix loop from the CLI, images returned to the model.
4. `manifold-3d` validation on the exported 3MF.

Exit criteria: each spike has a README with commands, timings, and a go/no-go note.

**Phase 1 — Core loop (≈2 weeks).** Chat → agent → server render → preview mesh in three.js → history snapshots → 3MF export. No WASM preview, no annotate, no sliders yet. Exit: Scenario A end-to-end.

**Phase 2 — Parametric + live (≈2 weeks).** WASM worker preview, Customizer parser → sliders, params persisted and passed to both renderers, History tab with diff and revert.

**Phase 3 — Steering + quality (≈2–3 weeks).** Annotate overlay with camera-pose capture; self-correction pass tuning; validation heuristics; export gating. Exit: Scenario B end-to-end.

**Phase 4 — Agent-native + release (≈1–2 weeks).** MCP server package; docker compose release; docs; prompt library; evaluation set (10–20 reference prompts with expected properties) run against each change.

**v2 backlog.** Photo → spec → model (Scenario D); multi-provider via Vercel AI SDK; diff-based `edit_scad` tool; STEP export via an OCCT sidecar; library manager; hosted mode.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| WASM preview too slow for BOSL2-heavy models | Preview is for parameter tweaks; server render remains the authority. Debounce, cache by (scad, params) hash, show stale-preview indicator. |
| Nightly OpenSCAD instability / flag drift | Pin a build date in `docker/` and `project.json`; spike verifies every flag we rely on; CI runs the eval set against the pinned build. |
| GPL-2 obligations from openscad-wasm and playground code | Decide license before Phase 1. Recommendation: GPL-3-compatible (OpenSCAD is GPL-2-or-later); keep `packages/agent` and `packages/mcp-server` free of GPL code so they could be relicensed if the WASM piece is later swapped. |
| Annotation UX eats the schedule (ModelRift: "weeks") | Ship arrows + text only first; rectangles/freehand after. Capture camera pose from day one — it's cheap and does most of the work. |
| Agent "improves" beyond the ask | 2-pass cap, explicit "only fix defects, don't add features" instruction in the self-correction prompt, diffs visible in History. |
| Renders look right, mesh is wrong | Validation on exported mesh is mandatory before hand-back and export. |
| Untrusted `.scad` (imports, huge loops) | OpenSCAD has no file/system access beyond `include/import`; run in a container with a temp dir, timeout, and memory cap. |
| Token cost per turn with 4–5 images | Downscale views to ≤1024 px; send `section` only when validation flags something or user asks; cache renders by hash. |

## 14. Open questions

1. Project name and license (blocking before Phase 1 code is public). → **Resolved 2026-08-25: repo `scadforge`, GPL-3.0-or-later with GPL-free packages (see decision log).**
2. Which OpenSCAD nightly to pin; confirm GLB/3MF-with-color export in that build (Phase 0 answers this).
3. Should manual edits in the Code tab auto-run validation, or only on demand?
4. Eval set: which 10–20 reference parts represent Billy's real MakerWorld work? (Good seed: the parametric cylindrical container and the production location signs.)
5. Default build volume for printability warnings (e.g., 256×256×256 mm for a Bambu X1C class printer).

## 15. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-26 | LLM-written OpenSCAD, no generative 3D model | Parametric, print-ready output; strong prior art (ModelRift, GrandpaCAD) |
| 2026-08-26 | Local-first, self-hosted, BYO key | No hosting/sandboxing burden in v1; easy to open-source |
| 2026-08-26 | Hybrid rendering | Instant browser preview + deterministic server renders/validation for the agent |
| 2026-08-26 | All-TypeScript monorepo | One language; frontend is TS regardless; `manifold-3d` covers validation |
| 2026-08-26 | Claude Agent SDK first, provider seam for multi-provider later | Fastest path; tools double as MCP server |
| 2026-08-26 | v1 must-haves: annotate, sliders, MCP server, history+diff; 1–2 self-correction passes | User decision |
| 2026-08-26 | Photo-to-model is v2, designed for now | User decision |
| 2026-08-25 | Repo name `scadforge`; GitHub Issues/PRs canonical task system per /dev SOP | User decision at plan approval |
| 2026-08-25 | License GPL-3.0-or-later repo-wide; `packages/{agent,scad-core,protocol,mcp-server}` GPL-free (Apache-2.0) with CI license gate; GPL-derived code confined to `apps/web/src/wasm/**` | User decision at plan approval |
| 2026-08-25 | Model policy: Opus as Tech Lead + intricate lanes (contract freezes, integration, agent-runtime/prompt work); Sonnet for all other workers, QA, and research | User decision at plan approval |

## 16. Bootstrapping in Claude Code

Drop this file at `docs/SDP.md` in an empty repo and start with:

1. "Read docs/SDP.md. Scaffold the pnpm monorepo in §11 with TypeScript, ESLint, and Vitest configured, and stub each package with a README describing its responsibility."
2. "Implement Phase 0 spike 2: a Dockerfile pinning an OpenSCAD nightly and a Node script that renders the fixed camera set and a 3MF from a sample BOSL2 model. Record timings in docs/spikes/02-openscad-cli.md."
3. Proceed spike by spike; each spike ends with a go/no-go note appended to §14 of this document.

A `CLAUDE.md` should carry: the pinned OpenSCAD version and flags, the 2-pass rule, "never paste full .scad into chat," and the license decision once made.

## 17. References

- openscad/openscad-wasm — https://github.com/openscad/openscad-wasm
- openscad/openscad-playground — https://github.com/openscad/openscad-playground (live: https://ochafik.com/openscad/)
- OpenSCAD downloads / nightlies — https://openscad.org/downloads.html
- Manifold (elalish/manifold) — https://github.com/elalish/manifold ; npm `manifold-3d`, PyPI `manifold3d`
- ModelRift: why OpenSCAD — https://modelrift.com/blog/why-openscad/
- ModelRift architecture write-up — https://pixeljets.com/blog/modelrift-ide-for-parametric-3d-modeling/
- ModelRift OpenSCAD LLM benchmark — https://modelrift.com/blog/openscad-llm-benchmark/
- GrandpaCAD engine comparison — https://grandpacad.com/en/blog/why-we-are-switching-to-openscad
- OpenSCAD MCP server (reference for tool surface) — https://github.com/sergiudanstan/openscad-mcp
- PythonSCAD — https://github.com/pythonscad/pythonscad
- CADCodeVerify (VLM self-verification for CAD code) — https://arxiv.org/abs/2410.05340
- EvoCAD — https://arxiv.org/abs/2510.11631
