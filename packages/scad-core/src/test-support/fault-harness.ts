// SPDX-License-Identifier: Apache-2.0
//
// @scadforge/scad-core — fault-qualification harness (Issue #99, S3-B ticket
// B8, Phase 1).
//
// TEST-SUPPORT ONLY. Deliberately NOT exported from `../index.ts` (see that
// file's barrel) — no production code path can reach this module, and it
// must never ship. It spawns REAL `node` child processes and kills them with
// a REAL `SIGKILL`, so a caller can observe recovery on a process that
// actually died rather than on a hand-built directory or an in-process throw
// (`transaction.ts`'s `__setFaultActionForTests` swap serves that narrower,
// same-process purpose for other tests; this harness exists precisely
// because nothing in the repository proved the crash-boundary table against
// a process that really dies — see the B8 ticket's "What the inventory
// found").
//
// ── WHY THE DRIVER SCRIPTS ARE PLAIN JAVASCRIPT, NOT TYPESCRIPT ────────────
//
// A driver is spawned as a genuinely separate OS process
// (`process.execPath <driver>.mjs`), never through vitest's own transform
// pipeline, so it cannot rely on vitest resolving this package's own
// `./foo.js` specifiers to sibling `.ts` source the way an in-process test
// import does. Every driver instead imports the ALREADY-BUILT
// `@scadforge/scad-core` package (`dist/index.js`, per its `package.json`
// `exports`) — exactly the same standing assumption every other package in
// this monorepo already makes of `scad-core` (`apps/server`'s own
// `package.json` points at the same `dist/`), so this harness adds no new
// build-ordering requirement. `assertScadCoreBuilt`/`assertServerBuilt` below
// fail loudly with a `pnpm -r build` hint rather than surfacing an obscure
// `ERR_MODULE_NOT_FOUND` when that assumption is not yet met.
//
// ── SCADFORGE_FAULT_POINT NEVER LEAKS INTO THIS (THE TEST RUNNER'S) PROCESS ─
//
// `transaction.ts`'s `faultPoint()` reads `process.env.SCADFORGE_FAULT_POINT`
// directly and, when armed, calls `process.kill(process.pid, "SIGKILL")` on
// WHATEVER process is currently running it. Every helper below sets that
// variable ONLY on a spawned child's own `env` object — never on
// `process.env` of the vitest worker this file itself runs in, which also
// calls ordinary (non-fault-armed) scad-core reads/recovery in-process after
// killing a child. `assertFaultPointEnvClean` is both a module-load guard and
// something a test's own `beforeEach` should call too (belt and suspenders):
// if this process's own environment ever carried that variable, an ordinary
// recovery read here would SIGKILL the test runner itself.
//
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FaultPointName } from "../store/transaction.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/scad-core/src/test-support/` -> repo root. */
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const SCAD_CORE_DIST_ENTRY = join(HERE, "..", "..", "dist", "index.js");
const SERVER_DIST_ENTRY = join(REPO_ROOT, "apps", "server", "dist", "index.js");
export const DRIVERS_DIR = join(HERE, "drivers");

// ═════════════════════════════════════════════════════════════════════════
// Env-leak guard (see module header)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Throws if `SCADFORGE_FAULT_POINT` is set on THIS process's own
 * environment. Called once at module load, and every fault-matrix test's
 * `beforeEach` calls it again explicitly — a second, redundant check is the
 * point: a leaked env var must never reach the point of arming a real
 * in-process recovery read.
 */
export function assertFaultPointEnvClean(): void {
  if (process.env.SCADFORGE_FAULT_POINT !== undefined) {
    throw new Error(
      "fault-harness: SCADFORGE_FAULT_POINT is set on this (the test runner's) own " +
        "process environment. It must be set ONLY on a spawned child's env object " +
        "-- never here, or an ordinary in-process recovery read would SIGKILL the " +
        "test runner itself. Unset it and re-run."
    );
  }
}
assertFaultPointEnvClean();

// ═════════════════════════════════════════════════════════════════════════
// Build-artifact guards (C3)
// ═════════════════════════════════════════════════════════════════════════

async function assertBuilt(path: string, hint: string): Promise<void> {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    throw new Error(`fault-harness: required build artifact missing at '${path}' -- run \`pnpm -r build\` first (${hint}).`);
  }
}

/** `packages/scad-core/dist/index.js` -- every driver script imports this. */
export async function assertScadCoreBuilt(): Promise<void> {
  await assertBuilt(SCAD_CORE_DIST_ENTRY, "needed by every fault-harness driver script");
}

/** `apps/server/dist/index.js` -- the server-child driver mode spawns this directly. */
export async function assertServerBuilt(): Promise<void> {
  await assertBuilt(SERVER_DIST_ENTRY, "needed by the fault-harness server-child mode");
}

// ═════════════════════════════════════════════════════════════════════════
// Child-process hygiene (C5): every spawned child is tracked so a suite can
// prove none is left running, even after an assertion throws mid-case.
// ═════════════════════════════════════════════════════════════════════════

const trackedChildren = new Set<ChildProcess>();

function trackChild(child: ChildProcess): ChildProcess {
  trackedChildren.add(child);
  child.once("exit", () => trackedChildren.delete(child));
  return child;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Kills (SIGKILL) and awaits every still-running tracked child. Safe to call unconditionally from `afterEach`. */
export async function killAllTrackedChildren(): Promise<void> {
  const children = [...trackedChildren];
  await Promise.all(
    children.map(async (child) => {
      if (!isRunning(child)) return;
      child.kill("SIGKILL");
      await waitForExit(child, 5000).catch(() => {});
    })
  );
}

/** Throws if any tracked child is still running -- call at the end of `afterEach`, AFTER `killAllTrackedChildren`, as the actual hygiene proof. */
export function assertNoTrackedChildrenRunning(): void {
  const running = [...trackedChildren].filter(isRunning);
  if (running.length > 0) {
    throw new Error(
      `fault-harness: ${running.length} child process(es) still running at cleanup time ` +
        `(pid(s): ${running.map((c) => c.pid).join(", ")}) -- every spawned child must be ` +
        "killed and awaited before the case completes."
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Exit / condition waiting -- bounded timeouts, never fixed sleeps (C5)
// ═════════════════════════════════════════════════════════════════════════

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function waitForExit(child: ChildProcess, timeoutMs = 15000): Promise<ExitInfo> {
  if (!isRunning(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fault-harness: child pid=${child.pid ?? "?"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description: string;
}

/** Polls `check` until it returns true, or throws naming `description` after `timeoutMs`. Never a fixed sleep as synchronization -- the loop's own condition is the synchronization. */
export async function waitFor(check: () => Promise<boolean> | boolean, options: WaitForOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`fault-harness: condition '${options.description}' was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, intervalMs));
  }
}

/** Resolves once `child`'s stdout has printed a line exactly equal to `marker` (used by the hold-lock driver to prove it actually holds the boundary before the parent acts on it). Rejects if the child exits first. */
export function waitForStdoutMarker(child: ChildProcess, marker: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`fault-harness: child pid=${child.pid ?? "?"} exited (code=${code}, signal=${signal}) before printing '${marker}'`));
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.split("\n").some((line) => line.trim() === marker)) {
        cleanup();
        resolvePromise();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`fault-harness: '${marker}' not observed on child pid=${child.pid ?? "?"} stdout within ${timeoutMs}ms`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Driver spawning (C1: fault point set ONLY on the child's own env)
// ═════════════════════════════════════════════════════════════════════════

export interface RunDriverOptions {
  /** Set ONLY on the spawned child's environment (C1) -- never this process's. */
  faultPoint?: FaultPointName;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface DriverResult extends ExitInfo {
  stdout: string;
  stderr: string;
}

function driverEnv(options: RunDriverOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env,
    ...(options.faultPoint !== undefined ? { SCADFORGE_FAULT_POINT: options.faultPoint } : {})
  };
}

/** Spawns `<DRIVERS_DIR>/<driverName>.mjs`, tracked for cleanup, without waiting for it. */
export async function spawnDriver(driverName: string, args: string[] = [], options: RunDriverOptions = {}): Promise<ChildProcess> {
  await assertScadCoreBuilt();
  const driverPath = join(DRIVERS_DIR, `${driverName}.mjs`);
  const child = spawn(process.execPath, [driverPath, ...args], {
    env: driverEnv(options),
    stdio: ["ignore", "pipe", "pipe"]
  });
  return trackChild(child);
}

/** Spawns a driver and waits for it to exit (by SIGKILL, or a normal exit), capturing stdout/stderr. */
export async function runDriverToCompletion(driverName: string, args: string[] = [], options: RunDriverOptions = {}): Promise<DriverResult> {
  const child = await spawnDriver(driverName, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exitInfo = await waitForExit(child, options.timeoutMs ?? 15000);
  return { ...exitInfo, stdout, stderr };
}

export async function killChild(child: ChildProcess, timeoutMs = 5000): Promise<ExitInfo> {
  if (!isRunning(child)) return { code: child.exitCode, signal: child.signalCode };
  child.kill("SIGKILL");
  return waitForExit(child, timeoutMs);
}

// ═════════════════════════════════════════════════════════════════════════
// Server-child mode (C2): reserve a real free port in the parent, pass it
// explicitly, and confirm readiness by polling GET /api/health -- never by
// parsing the server's own log text, and never `PORT=0` (the server prints
// the port it was CONFIGURED with, not the port it bound).
// ═════════════════════════════════════════════════════════════════════════

async function reserveFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        server.close();
        reject(new Error("fault-harness: could not read a bound address while reserving a free port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolvePromise(port)));
    });
  });
}

export interface ServerChildHandle {
  child: ChildProcess;
  port: number;
  baseUrl: string;
  projectsDir: string;
}

export interface StartServerChildOptions {
  /** Always a fresh temp directory -- NEVER `apps/server/data` (C2). */
  projectsDir: string;
  faultPoint?: FaultPointName;
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}

/** Spawns the real, built `apps/server` on a parent-reserved free port and waits for `GET /api/health` to answer before returning. */
export async function startServerChild(options: StartServerChildOptions): Promise<ServerChildHandle> {
  await assertServerBuilt();
  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [SERVER_DIST_ENTRY],
    {
      env: driverEnv({
        ...options,
        env: { ...options.env, PORT: String(port), SCADFORGE_PROJECTS_DIR: options.projectsDir }
      }),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  trackChild(child);

  await waitFor(
    async () => {
      if (!isRunning(child)) {
        throw new Error(
          `fault-harness: server child pid=${child.pid ?? "?"} exited before becoming ready ` +
            `(code=${child.exitCode}, signal=${child.signalCode})`
        );
      }
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        return res.ok;
      } catch {
        return false; // ECONNREFUSED while the server is still starting -- keep polling
      }
    },
    { timeoutMs: options.readyTimeoutMs ?? 10000, intervalMs: 50, description: `server child ${baseUrl}/api/health` }
  );

  return { child, port, baseUrl, projectsDir: options.projectsDir };
}
