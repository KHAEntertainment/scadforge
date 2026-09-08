#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// ─────────────────────────────────────────────────────────────────────────────
// Scenario A2 — M2 integration harness (Issue #35).
//
// Proves the parametric loop works end-to-end through the REAL server HTTP
// API and REAL agent tool-handler seam — no fakes, no live Claude Agent SDK
// turn (Scenario A already covers that regression separately; the M2
// integration owner's budget here is $0 of live-model usage) — and that the
// browser preview (openscad-wasm) and the authoritative server render
// (pinned Docker OpenSCAD) agree on geometry.
//
// GPL boundary (PROJECT_CONTEXT.md License section: GPL-derived code lives
// only under `apps/web/src/wasm/**`): this file NEVER imports
// `apps/web/src/wasm/**` — it SPAWNS `nodeWasmRender.mjs` as a child process,
// which is a process boundary as well as a directory boundary. This file also
// does not import `packages/scad-core`/`packages/agent` as workspace
// dependencies (`evals/` is deliberately outside `pnpm-workspace.yaml`) — it
// reaches their already-built `dist/` output via plain relative file:// URLs,
// the same way it reaches the server's own `dist/` to construct the REAL
// `ServerRuntime` + agent tool-handler seam in-process (see "AC4" below).
//
// Usage:
//   node evals/scenario-a2/run.mjs [--keep] [--project-root DIR] [--no-compose] [--negative-control]
//
//   --keep             leave the project directory behind for inspection
//   --project-root     where projects are created (default: a temp dir)
//   --no-compose       skip the compose build/verify step (pinned image already present)
//   --negative-control append a deliberately-failing assertion to prove the
//                      harness exits non-zero when an assertion fails
//
// Exits non-zero if any assertion fails. Every assertion is a real, unweakened
// check of the current backend behavior. AC6 (revert restores render/mesh
// bytes) and AC7 (export validation reflects the override params) cover
// defects that were reproduced earlier and are owned by the backend worker:
// they assert the CORRECT behavior and fail only if the backend regresses.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const EVIDENCE_DIR = join(HERE, "evidence");
const FIXTURE_PATH = join(HERE, "fixture", "clamp.scad");
const NODE_WASM_RENDER = join(REPO_ROOT, "apps", "web", "src", "wasm", "nodeWasmRender.mjs");

// This harness owns port 3298 (Scad Forge M2 integration handoff — the lead
// reserves 3299 for Scenario A/browser verification and 5273 for the Vite
// dev server). Never widen this without re-coordinating: two harnesses on the
// same port would corrupt each other's evidence.
const SERVER_PORT = Number(process.env.SCADFORGE_A2_EVAL_PORT ?? 3298);

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const KEEP = flag("--keep");
const SKIP_COMPOSE = flag("--no-compose");
const NEGATIVE_CONTROL = flag("--negative-control");

// ── transcript ───────────────────────────────────────────────────────────────

const startedAt = Date.now();
const transcript = [];
const timings = {};

function stamp() {
  return `+${String((Date.now() - startedAt) / 1000).padStart(7, " ")}s`;
}

function log(line) {
  const text = `[${stamp()}] ${line}`;
  transcript.push(text);
  console.log(text);
}

async function phase(name, fn) {
  const t0 = Date.now();
  log(`── ${name}`);
  try {
    return await fn();
  } finally {
    timings[name] = Date.now() - t0;
    log(`   ${name}: ${(timings[name] / 1000).toFixed(2)}s`);
  }
}

// ── assertions ───────────────────────────────────────────────────────────────

const results = [];

function assert(id, description, ok, detail) {
  results.push({ id, description, ok: Boolean(ok), detail: detail ?? null });
  const line = `[${id}] ${description} → ${ok ? "PASS" : "FAIL"}${detail ? ` — ${detail}` : ""}`;
  transcript.push(line);
  console.log(line);
}

// ── process helpers ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command to completion; resolves {stdout, stderr} on exit 0, rejects otherwise. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr || stdout}`));
    });
  });
}

let projectsRoot = null;
let serverProcess = null;
let serverLog = "";

async function composeUp() {
  if (SKIP_COMPOSE) {
    log("   compose step skipped (--no-compose)");
    return;
  }
  // `docker compose up openscad` builds the pinned image and prints
  // `openscad --version` — the cheapest proof that the exact pin the renderer
  // will invoke is present and runnable on this machine. Mirrors Scenario A.
  const { stdout, stderr } = await run("docker", ["compose", "up", "--build", "openscad"]);
  const version = `${stdout}${stderr}`.split("\n").find((l) => l.includes("OpenSCAD version"));
  log(`   ${version?.trim() ?? "OpenSCAD version line not found in compose output"}`);
}

async function startServer() {
  const entry = join(REPO_ROOT, "apps", "server", "dist", "index.js");
  if (!existsSync(entry)) throw new Error(`server build not found at ${entry} — run \`pnpm -r build\` first`);

  // Lifecycle correctness: a `/api/health` on 127.0.0.1:3298 can be answered
  // by ANOTHER process already bound to that port, which would make this
  // harness silently drive someone else's server if its own child failed to
  // bind (EADDRINUSE). The child is therefore only accepted once ITS OWN
  // stdout carries the exact "listening" line `apps/server/dist/index.js`
  // prints in the `serve` callback — the child's successful-bind signal —
  // AND the health probe answers. If the child exits first, we fail fast
  // rather than mutating a foreign server's data.
  let listening = false;
  let childExit = null;

  serverProcess = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(SERVER_PORT), SCADFORGE_PROJECTS_DIR: projectsRoot }
  });
  serverProcess.stdout.on("data", (d) => {
    const text = d.toString();
    serverLog += text;
    if (text.includes("ScadForge server listening on")) listening = true;
  });
  serverProcess.stderr.on("data", (d) => {
    serverLog += d.toString();
  });
  serverProcess.on("error", (err) => {
    serverLog += `\n[child error] ${err}\n`;
    childExit = err;
  });
  serverProcess.on("exit", (code) => {
    childExit = childExit ?? code;
  });

  const base = `http://127.0.0.1:${SERVER_PORT}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (childExit !== null) {
      throw new Error(`server child exited before binding (${childExit})\n${serverLog}`);
    }
    if (listening) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          log(`   server healthy at ${base} (${JSON.stringify(await res.json())})`);
          return base;
        }
      } catch {
        // child reported listening but health not yet answerable; retry
      }
    }
    await sleep(100);
  }
  throw new Error(`server did not become healthy on ${base}\n${serverLog}`);
}

async function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill("SIGTERM");
  await sleep(300);
  if (!serverProcess.killed) serverProcess.kill("SIGKILL");
}

async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Spawns the SAME `nodeWasmRender.mjs` the browser preview's Node-side proof
 * uses (see its own header for what is/is not shared with the real browser
 * worker). `--experimental-strip-types` is passed EXPLICITLY: this repo's
 * pinned toolchain is Node 22 (CLAUDE.md), and Node only strips `.ts` type
 * syntax without the flag from v23.6 onward — relying on a newer sandbox
 * Node's default-on behavior here would silently break under CI's pinned
 * Node 22. `--no-warnings` only suppresses the (harmless, flag-is-already
 * effectively covering our syntax) ExperimentalWarning noise; it changes
 * nothing about what runs.
 */
function runNodeWasmRender(scadPath, outPath, params, metaPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", NODE_WASM_RENDER, scadPath, outPath, JSON.stringify(params), "--meta", metaPath],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`nodeWasmRender.mjs exited ${code}\n${stderr || stdout}`));
    });
  });
}

// ── scad-core's mesh validator, reused directly (not reimplemented) ─────────
//
// `evals/` is intentionally outside `pnpm-workspace.yaml` (it is not a
// product package), so this reaches `@scadforge/scad-core`'s already-built
// `validateMesh` via a plain relative `dist/` import rather than a workspace
// dependency. Node resolves `manifold-3d` (scad-core's own dependency) by
// walking up from that dist file's OWN location on disk
// (`packages/scad-core/node_modules/`), not from this file's location, so
// this works without hoisting anything to the repo root.
const scadCoreDistUrl = pathToFileURL(join(REPO_ROOT, "packages", "scad-core", "dist", "index.js")).href;
const { validateMesh } = await import(scadCoreDistUrl);

/** Runs the frozen `validateMesh` against a mesh file and returns its report. */
async function measureMesh(meshPath) {
  const { report } = await validateMesh({ meshPath });
  return report;
}

function bboxSize(bbox) {
  if (!bbox) return null;
  return [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
}

/** All six bbox coordinates, so agreement checks catch translation, not just size. */
function bboxCorners(bbox) {
  if (!bbox) return null;
  return [bbox.min[0], bbox.min[1], bbox.min[2], bbox.max[0], bbox.max[1], bbox.max[2]];
}

/** SHA-256 hex of a byte buffer, for byte-for-byte artifact comparison. */
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Captures a snapshot's durable content — its captured `scad`, every render
 * PNG (fetched + hashed), its persisted mesh (fetched + hashed), and its
 * validation summary — as a byte-fingerprint. Used to prove a revert restored
 * the SAME bytes (AC6) and that the ORIGINAL snapshot was never mutated across
 * the run (AC8: history immutability).
 */
async function fingerprintSnapshot(base, projectId, snapshotId) {
  const snap = await api(base, `/api/projects/${projectId}/snapshots/${snapshotId}`);
  const renders = [];
  for (const r of snap.snapshot.renders ?? []) {
    const res = await fetch(`${base}${r.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    renders.push({ view: r.view, ok: res.ok, bytes: buf.length, sha256: sha256(buf) });
  }
  let mesh = null;
  const meshRes = await fetch(`${base}/api/projects/${projectId}/snapshots/${snapshotId}/mesh`);
  if (meshRes.ok) {
    const buf = Buffer.from(await meshRes.arrayBuffer());
    mesh = { bytes: buf.length, sha256: sha256(buf) };
  } else {
    mesh = { bytes: 0, sha256: null, status: meshRes.status };
  }
  return { snapshotId, scad: snap.scad, renders, mesh, validation: snap.snapshot.validation ?? null };
}

// ── the real agent tool-handler seam, in-process (AC4) ──────────────────────
//
// Per project-lead correction: `set_params` must be exercised through the
// ACTUAL seam the agent turn uses — `createToolHandlers(...).handlers.
// set_params` — not merely the REST `PUT .../params` route (which happens to
// share validation logic, but is not the same code path a live agent turn
// calls). This constructs the SAME `ServerRuntime` (`apps/server`'s own
// `createServerRuntime`) pointed at the SAME `SCADFORGE_PROJECTS_DIR` the
// spawned HTTP server above uses, and the SAME `createAgentScadCore` adapter
// `apps/server/src/services/agent-wiring.ts` binds a live turn to. No Claude
// Agent SDK call happens anywhere in this file — `createToolHandlers` returns
// plain async functions the SDK's tool-call loop would otherwise invoke; this
// harness invokes one of those functions directly, for $0 and no network call
// to any model provider.
const serverDistUrl = (...segments) => pathToFileURL(join(REPO_ROOT, "apps", "server", "dist", ...segments)).href;
const { createServerRuntime } = await import(serverDistUrl("services", "runtime.js"));
const { createAgentScadCore, createLibraryIndex } = await import(serverDistUrl("services", "agent-scad-core.js"));
const { createToolHandlers, PassBudget, ToolActivityRecorder } = await import(
  pathToFileURL(join(REPO_ROOT, "packages", "agent", "dist", "index.js")).href
);

function buildToolHandlers(runtime, projectId) {
  const scadCore = createAgentScadCore({ runtime, projectId });
  const libraries = createLibraryIndex();
  const budget = new PassBudget();
  const activity = new ToolActivityRecorder();
  const handlers = createToolHandlers({
    scadCore,
    libraries,
    budget,
    activity,
    turnId: "scenario-a2-harness",
    projectId,
    emit: () => {} // no SSE listener; this harness reads outcomes from the handler's own return value
  });
  return handlers;
}

/** Parses a tool handler's frozen `{content:[{type:"text",text:"<json>"}]}` envelope. */
function toolJson(result) {
  const block = result.content.find((b) => b.type === "text");
  return JSON.parse(block.text);
}

// ── the run ──────────────────────────────────────────────────────────────────

// Justified per-metric tolerances for the WASM/server agreement check (AC2).
//
// WHY ANY TOLERANCE AT ALL. The two renderers are NOT the same OpenSCAD build:
// the vendored WASM artifact is the openscad-wasm CI build of OpenSCAD
// 2025.03.25 (`apps/web/public/wasm/PROVENANCE.md`), while the server renders
// through the pinned Docker image, OpenSCAD 2026.01.19 (CLAUDE.md) — a
// ~10-month version gap, plus native-vs-WASM-compiled Manifold binaries. The
// fixture's `$fn=48` fixes the circle subdivision count on BOTH sides, but the
// two Manifold builds can still round the resulting 48-gon vertices slightly
// differently through boolean ops (circle tessellation → polygon vertices →
// union/difference), which shows up as a sub-percent volume and sub-0.1 mm
// bbox delta between two independently-compiled libraries. Those are the
// deltas the tolerance absorbs.
//
// WHY THESE SIZES. The bounds are chosen from the fixture's own geometry, not
// an arbitrary epsilon: at `$fn=48` the chord error on a 32 mm bore is
// ~0.01 mm per facet, so even a full one-facet disagreement in how the two
// builds split a circle cannot move a bbox corner by more than ~0.1 mm, and
// the corresponding swept volume error is far below 0.5%. A divergence beyond
// these bounds is NOT polygonization noise — it is a real defect (a wrong
// `-D` override, a stale WASM binary, a backend/staging mismatch) and MUST
// trip the assertion.
//
// NO LOOSENING. These constants are fixed at the values above. If a run ever
// measures a delta near or past them, the correct response is to diagnose the
// real divergence and fix its cause, NOT to raise the tolerance to make the
// run green — a widened tolerance would hide exactly the regression this
// check exists to catch. The evidence JSON records the measured deltas so a
// near-miss is visible as such.
const VOLUME_REL_TOLERANCE = 0.005; // 0.5% of server volume
const BBOX_ABS_TOLERANCE_MM = 0.1;

// Three settings, per AC2/AC3 — none equal the fixture's own default (3mm),
// which is used separately as the AC6 revert-target baseline so the two
// concerns don't share state.
const SWEEP_WALL_VALUES = [2, 4.5, 6];

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  projectsRoot = option("--project-root", null) ?? (await mkdtemp(join(tmpdir(), "scadforge-scenario-a2-")));
  log(`Scenario A2 — projects root: ${projectsRoot}`);

  await phase("compose up (pinned OpenSCAD)", composeUp);
  const base = await phase("start server", startServer);
  const fixtureScad = await readFile(FIXTURE_PATH, "utf8");

  // ── project setup ────────────────────────────────────────────────────────
  const project = await phase("create project", () =>
    api(base, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Scenario A2 Clamp", scad: fixtureScad })
    })
  );
  const projectId = project.project.id;
  const originalSnapshotId = project.head.id;
  log(`   project id: ${projectId}; initial snapshot: ${originalSnapshotId}; params.json values=${JSON.stringify(project.params)}`);

  // ── AC1 — Customizer schema reachable over REST ─────────────────────────
  await phase("AC1 — Customizer schema", async () => {
    const params = await api(base, `/api/projects/${projectId}/params`);
    const wall = params.parameters.find((p) => p.name === "wall");
    assert(
      "AC1",
      "Customizer schema exposes `wall` (type/initial/min/max/step from the fixture's Customizer annotation)",
      wall && wall.type === "number" && wall.initial === 3 && wall.min === 1 && wall.max === 10 && wall.step === 0.5,
      wall
        ? `wall: type=${wall.type} initial=${wall.initial} min=${wall.min} max=${wall.max} step=${wall.step}; values=${JSON.stringify(params.values)}`
        : "no `wall` parameter in schema"
    );
  });

  // ── baseline: render + persist validation/mesh on the ORIGINAL snapshot,
  // via the real tool-handler seam (validate_mesh), so AC6 has a snapshot
  // with genuine renders + a persisted mesh to revert back to. ────────────
  const runtime = createServerRuntime({ ...process.env, SCADFORGE_PROJECTS_DIR: projectsRoot });
  const handlers = buildToolHandlers(runtime, projectId);

  await phase("render + validate original snapshot (wall=3)", async () => {
    const renderRes = await api(base, `/api/projects/${projectId}/renders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    log(`   rendered ${renderRes.views.filter((v) => v.ok).length}/${renderRes.views.length} views onto ${renderRes.snapshot}`);

    const validateResult = await handlers.validate_mesh({});
    const validateJson = toolJson(validateResult);
    log(`   validate_mesh(wall=3): manifold=${validateJson.report?.manifold} volume=${validateJson.report?.volume_mm3}mm³`);
  });

  // Capture the original snapshot's durable content (scad + render PNGs +
  // persisted mesh + validation) as a byte fingerprint BEFORE any mutation, so
  // AC6 can prove the revert restores the same bytes and AC8 can prove the
  // original snapshot was never touched across the run.
  let originalFingerprint = null;
  await phase("capture original snapshot fingerprint", async () => {
    originalFingerprint = await fingerprintSnapshot(base, projectId, originalSnapshotId);
    log(
      `   original ${originalSnapshotId}: scad=${originalFingerprint.scad.length}B, ` +
        `renders=${originalFingerprint.renders.map((r) => `${r.view}@${r.sha256.slice(0, 8)}`).join(",") || "(none)"}, ` +
        `mesh=${originalFingerprint.mesh?.sha256 ? originalFingerprint.mesh.sha256.slice(0, 8) : "none"}`
    );
  });

  // ── AC2/AC3/AC7 — WASM/server agreement + monotonic volume + the
  // preview-export validation-field defect, all read off the same sweep ──
  const sweep = [];
  await phase("AC2/AC3/AC7 — param sweep (export preview vs WASM)", async () => {
    for (const wall of SWEEP_WALL_VALUES) {
      const exportRes = await api(base, `/api/projects/${projectId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "stl", params: { wall } })
      });
      const stlRes = await fetch(`${base}${exportRes.export.url}`);
      const serverStlPath = join(projectsRoot, `.a2-server-wall-${wall}.stl`);
      await writeFile(serverStlPath, Buffer.from(await stlRes.arrayBuffer()));
      const serverReport = await measureMesh(serverStlPath);

      const wasmStlPath = join(projectsRoot, `.a2-wasm-wall-${wall}.stl`);
      const wasmMetaPath = join(projectsRoot, `.a2-wasm-wall-${wall}.meta.json`);
      await runNodeWasmRender(FIXTURE_PATH, wasmStlPath, { wall }, wasmMetaPath);
      const wasmReport = await measureMesh(wasmStlPath);

      sweep.push({ wall, server: serverReport, wasm: wasmReport, exportValidation: exportRes.validation });
      log(
        `   wall=${wall}: server vol=${serverReport.volume_mm3}mm³ bbox=${JSON.stringify(bboxSize(serverReport.bbox))} | ` +
          `wasm vol=${wasmReport.volume_mm3}mm³ bbox=${JSON.stringify(bboxSize(wasmReport.bbox))}`
      );
    }

    // AC2 — one line per setting. bbox agreement compares ALL SIX min/max
    // coordinates, not just the size (max-min): two meshes with the same
    // size+volume but a different position must still fail.
    for (const point of sweep) {
      const volDelta = Math.abs(point.server.volume_mm3 - point.wasm.volume_mm3);
      const volRel = volDelta / point.server.volume_mm3;
      const serverCorners = bboxCorners(point.server.bbox);
      const wasmCorners = bboxCorners(point.wasm.bbox);
      const cornerDeltas = serverCorners.map((c, i) => Math.abs(c - wasmCorners[i]));
      const bboxOk = cornerDeltas.every((d) => d <= BBOX_ABS_TOLERANCE_MM);
      const ok = point.server.manifold && point.wasm.manifold && volRel <= VOLUME_REL_TOLERANCE && bboxOk;
      assert(
        `AC2-wall${point.wall}`,
        `WASM/server volume+bbox(min/max corners) agree within tolerance at wall=${point.wall}`,
        ok,
        `Δvol=${volDelta.toFixed(4)}mm³ (${(volRel * 100).toFixed(3)}%, tol ${(VOLUME_REL_TOLERANCE * 100).toFixed(1)}%); ` +
          `Δcorners=[${cornerDeltas.map((d) => d.toFixed(4)).join(",")}]mm (tol ${BBOX_ABS_TOLERANCE_MM}mm)`
      );
    }

    // AC3 — param-driven, strictly monotonic volume change (closed-form
    // expectation from the fixture's own header comment).
    const volumes = sweep.map((p) => p.server.volume_mm3);
    const monotonic = volumes.every((v, i) => i === 0 || v > volumes[i - 1]);
    assert(
      "AC3",
      "server volume strictly increases with `wall` across the swept settings",
      monotonic,
      `volumes: ${sweep.map((p) => `wall=${p.wall}→${p.server.volume_mm3}mm³`).join(", ")}`
    );

    // AC7 — regression for the previously-reproduced preview-export
    // validation defect: `ExportResponse.validation` must describe the
    // OVERRIDE params this preview export actually asked about, not the head
    // snapshot's stale persisted validation. Every sweep point uses a
    // different wall (2, 4.5, 6), all != the wall=3 baseline, so a correct
    // response must report a different volume per point; a stale-head
    // implementation reports the same (wall=3) volume for all three.
    for (const point of sweep) {
      const reportedVolume = point.exportValidation?.volume_mm3 ?? null;
      const trueVolume = point.server.volume_mm3;
      const matches = reportedVolume !== null && Math.abs(reportedVolume - trueVolume) / trueVolume <= VOLUME_REL_TOLERANCE;
      assert(
        `AC7-wall${point.wall}`,
        `ExportResponse.validation reflects the actual preview override (wall=${point.wall}), not a stale head snapshot`,
        matches,
        `ExportResponse.validation.volume_mm3=${reportedVolume} vs actual exported-mesh volume=${trueVolume}mm³ (tol ${(VOLUME_REL_TOLERANCE * 100).toFixed(1)}%)`
      );
    }
  });

  // ── AC4 — set_params through the actual agent tool-handler seam,
  // visible over REST; also the "real parameter edits change authoritative
  // geometry" proof (wall 3→4mm, server-authoritative export). ────────────
  let postChangeSnapshotId = null;
  await phase("AC4 — set_params via the real tool-handler seam", async () => {
    const beforeExport = await api(base, `/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "stl" }) // no override: exports the CURRENT head (wall=3) as-staged
    });
    const beforeStlRes = await fetch(`${base}${beforeExport.export.url}`);
    const beforeStlPath = join(projectsRoot, ".a2-before-set-params.stl");
    await writeFile(beforeStlPath, Buffer.from(await beforeStlRes.arrayBuffer()));
    const beforeReport = await measureMesh(beforeStlPath);

    const setParamsResult = await handlers.set_params({ params: { wall: 4 } });
    const setParamsJson = toolJson(setParamsResult);
    postChangeSnapshotId = setParamsJson.snapshot;
    log(`   set_params(wall=4) via tool handler → snapshot ${postChangeSnapshotId}, unknown_params=${JSON.stringify(setParamsJson.unknown_params)}`);

    const paramsAfter = await api(base, `/api/projects/${projectId}/params`);

    const afterExport = await api(base, `/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "stl" })
    });
    const afterStlRes = await fetch(`${base}${afterExport.export.url}`);
    const afterStlPath = join(projectsRoot, ".a2-after-set-params.stl");
    await writeFile(afterStlPath, Buffer.from(await afterStlRes.arrayBuffer()));
    const afterReport = await measureMesh(afterStlPath);

    assert(
      "AC4a",
      "set_params (real tool-handler seam) is visible over REST GET .../params",
      setParamsJson.ok === true && setParamsJson.unknown_params.length === 0 && paramsAfter.values.wall === 4,
      `handler result wall=${setParamsJson.params?.wall}; REST GET wall=${paramsAfter.values.wall}`
    );
    assert(
      "AC4b",
      "the real parameter edit (wall 3→4mm) changes authoritative (server-rendered) geometry in the expected direction",
      beforeReport.manifold && afterReport.manifold && afterReport.volume_mm3 > beforeReport.volume_mm3,
      `wall=3 → ${beforeReport.volume_mm3}mm³; wall=4 → ${afterReport.volume_mm3}mm³`
    );
  });

  // ── AC5/AC6/AC8 — revert restores scad+params (verified via API), restores
  // the target snapshot's renders+mesh byte-for-byte, and leaves the ORIGINAL
  // snapshot untouched (history immutability). ────────────────────────────
  await phase("AC5/AC6/AC8 — revert + immutability", async () => {
    const revertRes = await api(base, `/api/projects/${projectId}/snapshots/${originalSnapshotId}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Scenario A2 revert check" })
    });
    const revertedId = revertRes.snapshot.id;
    log(`   reverted to ${originalSnapshotId} → new snapshot ${revertedId}`);

    const paramsAfterRevert = await api(base, `/api/projects/${projectId}/params`);
    const scadMatches = revertRes.scad === fixtureScad;
    // `project.params` is the ORIGINAL snapshot's params (captured at create,
    // before any override). Revert must restore params to exactly that bag.
    const paramsRestored = JSON.stringify(paramsAfterRevert.values) === JSON.stringify(project.params);

    assert(
      "AC5",
      "revert creates a NEW snapshot restoring scad+params, verified via the API",
      revertedId !== originalSnapshotId &&
        revertedId !== postChangeSnapshotId &&
        scadMatches &&
        paramsRestored,
      `new snapshot ${revertedId} (original ${originalSnapshotId}, pre-revert head ${postChangeSnapshotId}); ` +
        `scad matches=${scadMatches}; values=${JSON.stringify(paramsAfterRevert.values)} (original ${JSON.stringify(project.params)})`
    );

    // AC6 — the reverted snapshot must carry the SAME render PNG bytes and the
    // SAME persisted mesh bytes as the snapshot it reverted to. A non-empty
    // `renders` list alone would miss stale/missing URLs or re-rendered
    // (non-identical) bytes, so this compares SHA-256s of every fetched view
    // and of the mesh.
    const revertedFingerprint = await fingerprintSnapshot(base, projectId, revertedId);
    const originalViewHashes = new Map(originalFingerprint.renders.map((r) => [r.view, r.sha256]));
    const rendersMatch =
      originalFingerprint.renders.length > 0 &&
      revertedFingerprint.renders.length === originalFingerprint.renders.length &&
      revertedFingerprint.renders.every((r) => r.ok && r.sha256 === originalViewHashes.get(r.view));
    const meshMatch =
      originalFingerprint.mesh?.sha256 != null &&
      revertedFingerprint.mesh?.sha256 === originalFingerprint.mesh.sha256;
    assert(
      "AC6",
      "revert restores the target snapshot's render PNGs and persisted mesh byte-for-byte",
      rendersMatch && meshMatch,
      `reverted ${revertedId}: renders=[${revertedFingerprint.renders
        .map((r) => `${r.view}@${r.sha256.slice(0, 8)}${r.ok ? "" : "(fetch-failed)"}`)
        .join(",")}] vs original [${originalFingerprint.renders
        .map((r) => `${r.view}@${r.sha256.slice(0, 8)}`)
        .join(",")}]; mesh reverted=${revertedFingerprint.mesh?.sha256?.slice(0, 8) ?? "MISSING"} original=${originalFingerprint.mesh?.sha256?.slice(0, 8) ?? "none"}`
    );

    // AC8 — history immutability: the ORIGINAL snapshot's captured scad,
    // renders and mesh must be byte-identical after set_params + revert.
    const originalAfter = await fingerprintSnapshot(base, projectId, originalSnapshotId);
    const originalRendersUnchanged =
      originalAfter.renders.length === originalFingerprint.renders.length &&
      originalAfter.renders.every((r) => r.sha256 === originalViewHashes.get(r.view));
    const originalMeshUnchanged = originalAfter.mesh?.sha256 === originalFingerprint.mesh?.sha256;
    assert(
      "AC8",
      "the original snapshot's scad/renders/mesh are byte-identical after set_params + revert (history is immutable)",
      originalAfter.scad === originalFingerprint.scad && originalRendersUnchanged && originalMeshUnchanged,
      `original ${originalSnapshotId} unchanged: scad=${originalAfter.scad === originalFingerprint.scad}, ` +
        `renders=${originalRendersUnchanged}, mesh=${originalMeshUnchanged}`
    );
  });

  return { projectId, sweep };
}

// ── evidence + exit ──────────────────────────────────────────────────────────

let run_ = null;
let failure = null;
try {
  run_ = await main();
} catch (err) {
  failure = err;
  log(`FATAL: ${err.stack ?? err.message}`);
  assert("AC0", "the run completed without an unhandled error", false, err.message);
} finally {
  await stopServer();
}

// Negative control (--negative-control): prove the harness really exits
// non-zero when an assertion fails. A deliberately-false assertion is appended
// after the real run; the exit code must become 1 even if every real assertion
// above passed. Run once with this flag as recorded evidence (see the
// implementation artifact), never as part of the normal CI invocation.
if (NEGATIVE_CONTROL) {
  assert(
    "ACNEG",
    "negative control: a deliberately-failing assertion forces a non-zero exit",
    false,
    "expected failure (--negative-control)"
  );
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
const summary = `${passed}/${total} assertions passed`;
log(`── ${summary}`);

await mkdir(EVIDENCE_DIR, { recursive: true });
const stampName = new Date().toISOString().replace(/[:.]/g, "-");

await writeFile(
  join(EVIDENCE_DIR, `transcript-${stampName}.log`),
  [
    `# Scenario A2 — M2 integration harness (Issue #35)`,
    `# started: ${new Date(startedAt).toISOString()}`,
    `# flags: keep=${KEEP} no-compose=${SKIP_COMPOSE} negative-control=${NEGATIVE_CONTROL}`,
    `# node: ${process.version}  platform: ${process.platform}/${process.arch}`,
    "",
    ...transcript,
    "",
    "# ── server stdout/stderr ──",
    serverLog.trim()
  ].join("\n"),
  "utf8"
);

await writeFile(
  join(EVIDENCE_DIR, `results-${stampName}.json`),
  JSON.stringify(
    {
      started: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      flags: { keep: KEEP, no_compose: SKIP_COMPOSE, negative_control: NEGATIVE_CONTROL },
      timings_ms: timings,
      tolerances: { volume_rel: VOLUME_REL_TOLERANCE, bbox_abs_mm: BBOX_ABS_TOLERANCE_MM },
      sweep_wall_values: SWEEP_WALL_VALUES,
      assertions: results,
      summary,
      sweep: run_?.sweep ?? null,
      // No key material: this harness never invokes a model provider.
      error: failure ? String(failure.message) : null
    },
    null,
    2
  ),
  "utf8"
);

if (!KEEP && projectsRoot && !option("--project-root", null)) {
  await rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
} else if (projectsRoot) {
  log(`project store kept at ${projectsRoot}`);
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
