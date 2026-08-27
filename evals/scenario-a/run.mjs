#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// ─────────────────────────────────────────────────────────────────────────────
// Scenario A — end-to-end acceptance run (Issue #20).
//
// From a clean state, this drives the SDP's Scenario A prompt
//
//     "A wall-mount bracket for a 32 mm pipe with two M4 screw slots"
//
// through the REAL server HTTP API — no fakes, no in-process shortcuts, no
// direct scad-core calls — and asserts the five acceptance criteria. It is the
// proof that #14/#15/#16/#17/#19 are actually integrated, not merely merged.
//
// Everything it touches is real:
//   - the pinned OpenSCAD container (`docker compose` builds/verifies it first)
//   - a live Claude Agent SDK turn (~$0.15; credentials are inherited from the
//     host's Claude Code session — Spike 3 confirmed no API key is needed)
//   - the filesystem project store under a throwaway projects root
//
// Usage:
//   node evals/scenario-a/run.mjs [--keep] [--project-root DIR] [--no-compose]
//
//   --keep          leave the project directory behind for inspection
//   --project-root  where projects are created (default: a temp dir)
//   --no-compose    skip the compose build/verify step (image already present)
//   --server URL    drive an ALREADY-RUNNING server instead of starting one
//
// Exits non-zero if any assertion fails.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const EVIDENCE_DIR = join(HERE, "evidence");

/** The Scenario A prompt, verbatim from Issue #20 / the SDP. */
const PROMPT = "A wall-mount bracket for a 32 mm pipe with two M4 screw slots";

/**
 * AC 1 looks for these CONCEPTS in the Customizer schema, not for these exact
 * names: the agent authors the parameter names, and forcing an exact spelling
 * would be testing the prompt rather than the pipeline. Each entry is one
 * concept the bracket must expose, with the spellings that count as naming it.
 */
const REQUIRED_PARAM_CONCEPTS = [
  { concept: "pipe diameter", patterns: [/pipe.*d(ia)?/i, /\bd(ia)?.*pipe/i, /bore/i] },
  { concept: "wall thickness", patterns: [/wall/i, /thick/i] },
  { concept: "screw slots", patterns: [/slot/i, /screw/i, /mount.*hole/i] },
  { concept: "M4 screw size", patterns: [/screw.*d(ia)?/i, /\bm4\b/i, /bolt/i, /screw.*size/i] }
];

/** The 4 views a default render produces (scad-core `DEFAULT_VIEWS`). */
const EXPECTED_VIEWS = ["iso", "front", "right", "section"];

const SERVER_PORT = Number(process.env.SCADFORGE_EVAL_PORT ?? 3199);
const TURN_TIMEOUT_MS = Number(process.env.SCADFORGE_EVAL_TURN_TIMEOUT_MS ?? 15 * 60_000);

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const KEEP = flag("--keep");
const SKIP_COMPOSE = flag("--no-compose");
const EXTERNAL_SERVER = option("--server", null);

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

/** Records a phase's wall-clock duration. */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the run ──────────────────────────────────────────────────────────────────

let projectsRoot = null;
let serverProcess = null;
let serverLog = "";

async function composeUp() {
  if (SKIP_COMPOSE) {
    log("   compose step skipped (--no-compose)");
    return;
  }
  // `docker compose up openscad` on this service builds the pinned image and
  // prints `openscad --version` — the cheapest possible proof that the exact
  // pin the renderer will invoke is present and runnable on this machine.
  const { stdout, stderr } = await run("docker", ["compose", "up", "--build", "openscad"]);
  const version = `${stdout}${stderr}`.split("\n").find((l) => l.includes("OpenSCAD version"));
  log(`   ${version?.trim() ?? "OpenSCAD version line not found in compose output"}`);
}

async function startServer() {
  if (EXTERNAL_SERVER) {
    log(`   using external server at ${EXTERNAL_SERVER}`);
    return EXTERNAL_SERVER;
  }
  const entry = join(REPO_ROOT, "apps", "server", "dist", "index.js");
  if (!existsSync(entry)) throw new Error(`server build not found at ${entry} — run \`pnpm -r build\` first`);

  serverProcess = spawn(process.execPath, [entry], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(SERVER_PORT), SCADFORGE_PROJECTS_DIR: projectsRoot }
  });
  serverProcess.stdout.on("data", (d) => {
    serverLog += d.toString();
  });
  serverProcess.stderr.on("data", (d) => {
    serverLog += d.toString();
  });

  const base = `http://127.0.0.1:${SERVER_PORT}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        log(`   server healthy at ${base} (${JSON.stringify(await res.json())})`);
        return base;
      }
    } catch {
      // not listening yet
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

/** Drives the SSE chat turn, collecting every frame. */
async function runChatTurn(base, projectId, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const events = [];
  try {
    const res = await fetch(`${base}/api/projects/${projectId}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`chat turn → ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const dataLine = frame
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine.slice(5).trim());
          events.push(event);
          const detail =
            event.type === "tool_call"
              ? ` ${event.name}(${event.input_summary ?? ""}) pass=${event.pass}`
              : event.type === "tool_result"
                ? ` ${event.name} ok=${event.ok}${event.summary ? ` — ${event.summary}` : ""}`
                : event.type === "snapshot_created"
                  ? ` ${event.snapshot.id}`
                  : event.type === "turn_done"
                    ? ` status=${event.status} passes=${event.passes_used}`
                    : event.type === "error"
                      ? ` ${event.error_code}: ${event.message}`
                      : "";
          log(`   SSE ${event.type}${detail}`);
        } catch {
          // a non-JSON frame is not part of the frozen union; ignore it
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  projectsRoot = option("--project-root", null) ?? (await mkdtemp(join(tmpdir(), "scadforge-scenario-a-")));
  log(`Scenario A — projects root: ${projectsRoot}`);
  log(`Prompt: "${PROMPT}"`);

  await phase("compose up (pinned OpenSCAD)", composeUp);
  const base = await phase("start server", startServer);

  const project = await phase("create project", () =>
    api(base, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Scenario A Bracket" })
    })
  );
  const projectId = project.project.id;
  log(`   project id: ${projectId}`);

  const events = await phase("agent turn (LIVE)", () => runChatTurn(base, projectId, PROMPT));

  const turnDone = events.find((e) => e.type === "turn_done");
  log(`   turn status: ${turnDone?.status ?? "(no turn_done)"} after ${turnDone?.passes_used ?? "?"} pass(es)`);
  if (turnDone?.usage) log(`   usage: ${JSON.stringify(turnDone.usage)}`);
  for (const e of events.filter((e) => e.type === "error")) log(`   ERROR event: ${e.error_code} — ${e.message}`);

  // ── AC1: model.scad written with Customizer params ─────────────────────────
  await phase("AC1 — model.scad + Customizer schema", async () => {
    const state = await api(base, `/api/projects/${projectId}`);
    const scad = state.scad ?? "";
    const hasModel = scad.trim().length > 0 && /\b(module|cube|cylinder|difference|union|hull)\b/.test(scad);
    assert("AC1a", "model.scad written with real geometry", hasModel, `${scad.length} bytes`);

    const params = await api(base, `/api/projects/${projectId}/params`);
    const names = (params.parameters ?? []).map((p) => p.name);
    log(`   param schema (${names.length}): ${names.join(", ") || "(empty)"}`);
    const missing = REQUIRED_PARAM_CONCEPTS.filter(
      (concept) => !names.some((name) => concept.patterns.some((p) => p.test(name)))
    ).map((c) => c.concept);
    assert(
      "AC1b",
      "Customizer schema exposes pipe diameter, wall, slot and screw-size parameters",
      names.length > 0 && missing.length === 0,
      missing.length ? `missing concept(s): ${missing.join(", ")}` : `${names.length} parameters`
    );
    return { scad, names };
  });

  // ── AC2: the 4 view PNGs exist ─────────────────────────────────────────────
  const snapshots = await api(base, `/api/projects/${projectId}/snapshots`);
  await phase("AC2 — 4 view PNGs", async () => {
    // Renders attach to the head snapshot; find whichever snapshot carries them.
    const withRenders = snapshots.snapshots.find((s) => (s.renders ?? []).length > 0);
    const rendered = new Set((withRenders?.renders ?? []).map((r) => r.view));
    const missing = EXPECTED_VIEWS.filter((v) => !rendered.has(v));

    const fetched = [];
    for (const view of EXPECTED_VIEWS) {
      if (!withRenders) break;
      const res = await fetch(`${base}/api/projects/${projectId}/snapshots/${withRenders.id}/views/${view}`);
      if (!res.ok) continue;
      const bytes = (await res.arrayBuffer()).byteLength;
      // A PNG the server will actually serve, not just a manifest entry.
      if (bytes > 0) fetched.push(`${view}:${bytes}B`);
    }
    log(`   served PNGs: ${fetched.join(", ") || "(none)"}`);
    assert(
      "AC2",
      `all ${EXPECTED_VIEWS.length} view PNGs exist and are served`,
      missing.length === 0 && fetched.length === EXPECTED_VIEWS.length,
      missing.length ? `missing: ${missing.join(", ")}` : `snapshot ${withRenders?.id}`
    );
  });

  // ── AC3: ValidationReport manifold && components === 1 ─────────────────────
  await phase("AC3 — validation", async () => {
    // `tool_result` frames carry only a short summary (the frozen event shape
    // deliberately excludes payloads), so the verdict is read from where it is
    // PERSISTED: the snapshot manifest's `ValidationSummary`, written by the
    // `validate_mesh` handler via `attachValidationToSnapshot`. That is also
    // exactly what the History badge and `ExportResponse.validation` read.
    const validated = snapshots.snapshots.filter((s) => s.validation);
    const summary = validated.at(0)?.validation ?? null; // newest first
    const toolCalls = events.filter((e) => e.type === "tool_result" && e.name === "validate_mesh");
    log(`   validate_mesh tool results: ${toolCalls.length}; last summary: ${toolCalls.at(-1)?.summary ?? "(none)"}`);
    log(`   persisted validation: ${JSON.stringify(summary)}`);

    assert(
      "AC3",
      "ValidationReport.manifold === true && components === 1",
      summary?.manifold === true && summary?.components === 1,
      summary
        ? `badge=${summary.badge} manifold=${summary.manifold} components=${summary.components} volume=${summary.volume_mm3}mm³`
        : toolCalls.length === 0
          ? "the agent never called validate_mesh"
          : "no validation persisted to any snapshot"
    );
  });

  // ── AC4: snapshot 0001+ recorded with a diff ───────────────────────────────
  await phase("AC4 — snapshot history + diff", async () => {
    const ids = snapshots.snapshots.map((s) => s.id).sort();
    log(`   snapshots: ${ids.join(", ")}`);
    const agentSnapshots = snapshots.snapshots.filter((s) => s.id > "0001");
    let withDiff = null;
    for (const snapshot of agentSnapshots) {
      const diff = await api(base, `/api/projects/${projectId}/snapshots/${snapshot.id}/diff`);
      if (diff.diff && diff.diff.trim().length > 0) {
        withDiff = { id: snapshot.id, lines: diff.diff.split("\n").length };
        break;
      }
    }
    assert(
      "AC4",
      "snapshot 0001+ recorded, with a unified diff against its parent",
      ids.includes("0001") && withDiff !== null,
      withDiff ? `${ids.length} snapshots; ${withDiff.id} carries a ${withDiff.lines}-line diff` : `${ids.length} snapshots, no diff found`
    );
  });

  // ── AC5: 3MF exported and non-empty ────────────────────────────────────────
  await phase("AC5 — 3MF export", async () => {
    let record = null;
    let bytes = 0;
    try {
      const response = await api(base, `/api/projects/${projectId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "3mf" })
      });
      record = response.export;
      const file = await fetch(`${base}${record.url}`);
      bytes = file.ok ? (await file.arrayBuffer()).byteLength : 0;
      log(`   export: ${record.file} (${record.bytes}B recorded, ${bytes}B served)`);
    } catch (err) {
      log(`   export failed: ${err.message}`);
    }
    assert(
      "AC5",
      "3MF exported through the validation gate and non-empty",
      record !== null && record.format === "3mf" && record.bytes > 0 && bytes > 0,
      record ? `${record.file}: ${bytes} bytes served` : "no export produced"
    );
  });

  return { projectId, events, snapshots };
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

const passed = results.filter((r) => r.ok).length;
const total = results.length;
const summary = `${passed}/${total} assertions passed`;
log(`── ${summary}`);

await mkdir(EVIDENCE_DIR, { recursive: true });
const stampName = new Date().toISOString().replace(/[:.]/g, "-");

await writeFile(
  join(EVIDENCE_DIR, `transcript-${stampName}.log`),
  [
    `# Scenario A end-to-end run`,
    `# prompt: ${PROMPT}`,
    `# started: ${new Date(startedAt).toISOString()}`,
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
      prompt: PROMPT,
      started: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      timings_ms: timings,
      assertions: results,
      summary,
      // No key material: the SDK inherits the host session's credentials and
      // none of them are read, logged or persisted by this harness.
      turn: run_
        ? {
            project_id: run_.projectId,
            event_types: run_.events.map((e) => e.type),
            turn_done: run_.events.find((e) => e.type === "turn_done") ?? null
          }
        : null,
      error: failure ? String(failure.message) : null
    },
    null,
    2
  ),
  "utf8"
);

if (run_) {
  await writeFile(
    join(EVIDENCE_DIR, `sse-events-${stampName}.json`),
    JSON.stringify(run_.events, null, 2),
    "utf8"
  );
}

if (!KEEP && projectsRoot && !option("--project-root", null)) {
  await rm(projectsRoot, { recursive: true, force: true }).catch(() => {});
} else if (projectsRoot) {
  log(`project store kept at ${projectsRoot}`);
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
