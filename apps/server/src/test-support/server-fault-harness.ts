// SPDX-License-Identifier: Apache-2.0
//
// Fault qualification (S3-B ticket B8) -- shared server-child helpers.
// Extracted from Phase 1's `fault-server-child.test.ts` (Issue #99, C6
// correction on Issue #110) so Phase 2's new server-crash test files do not
// triplicate the same ~150 lines a third time. Behavior is unchanged from
// the Phase 1 inline version, with one real fix: the original `afterEach`
// hygiene check filtered the SAME array it had just `splice(0)`-emptied, so
// it was vacuously `[]` every time, never actually able to catch a leaked
// child. `createChildTracker().killAll()` below checks the SNAPSHOT it just
// killed instead, so it is a real assertion.
//
// This module does NOT import `packages/scad-core/src/test-support/fault-
// harness.ts` -- that file lives under scad-core's OWN `rootDir` ("src"),
// and this package's `tsconfig.json` (`rootDir: "src"`) refuses to compile a
// module graph that reaches outside it (`tsc` TS6059, confirmed while
// designing the Phase 1 file). This is test-support only, never imported by
// any production file.

import { type ChildProcess, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/server/src/test-support/` -> `apps/server/dist/index.js`. */
const SERVER_DIST_ENTRY = join(HERE, "..", "..", "dist", "index.js");

export async function assertServerBuilt(): Promise<void> {
  try {
    await access(SERVER_DIST_ENTRY, fsConstants.F_OK);
  } catch {
    throw new Error(`server-fault-harness: required build artifact missing at '${SERVER_DIST_ENTRY}' -- run \`pnpm -r build\` first.`);
  }
}

/** Every fault-qualification test's `beforeEach` calls this. SCADFORGE_FAULT_POINT must never be set on the test runner's OWN process -- only on a spawned child's environment. */
export function assertFaultPointEnvClean(): void {
  if (process.env.SCADFORGE_FAULT_POINT !== undefined) {
    throw new Error(
      "server-fault-harness: SCADFORGE_FAULT_POINT is set on this (the test runner's) own process " +
        "environment -- it must be set ONLY on a spawned server child's env, never here."
    );
  }
}

/** Reserve a real free port in the parent -- `apps/server` prints the port it was CONFIGURED with, not the one it bound, so `PORT=0` cannot be polled for readiness. */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        server.close();
        reject(new Error("server-fault-harness: could not read a bound address while reserving a free port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolvePromise(port)));
    });
  });
}

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description: string;
}

/** Bounded polling -- never a fixed sleep as synchronization. */
export async function waitFor(check: () => Promise<boolean> | boolean, options: WaitForOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`server-fault-harness: condition '${options.description}' was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, intervalMs));
  }
}

export function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function waitForExit(child: ChildProcess, timeoutMs = 10000): Promise<ExitInfo> {
  if (!isRunning(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server-fault-harness: child pid=${child.pid ?? "?"} did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

export async function killChild(child: ChildProcess): Promise<void> {
  if (!isRunning(child)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 5000).catch(() => {});
}

// ── Child hygiene (C5: every spawned child killed and awaited, none orphaned) ──

export interface ChildTracker {
  track(child: ChildProcess): ChildProcess;
  /** Kills every tracked child, awaits each, then throws if any of THOSE SPECIFIC children is still running -- a real proof, not a check against the now-empty tracking list. */
  killAll(): Promise<void>;
}

export function createChildTracker(): ChildTracker {
  const children: ChildProcess[] = [];
  return {
    track(child) {
      children.push(child);
      return child;
    },
    async killAll() {
      const snapshot = children.splice(0);
      await Promise.all(snapshot.map((child) => killChild(child)));
      const stillRunning = snapshot.filter(isRunning);
      if (stillRunning.length > 0) {
        throw new Error(
          `server-fault-harness: ${stillRunning.length} child process(es) still running after killAll ` +
            `(pid(s): ${stillRunning.map((c) => c.pid).join(", ")})`
        );
      }
    }
  };
}

// ── Server-child spawning ───────────────────────────────────────────────────

export interface ServerChildHandle {
  child: ChildProcess;
  baseUrl: string;
}

export interface StartServerChildOptions {
  faultPoint?: string;
  readyTimeoutMs?: number;
}

/** Spawns the real, built `apps/server` on a parent-reserved free port and waits for `GET /api/health` before returning. Tracked via `tracker.track` automatically. */
export async function startServerChild(
  tracker: ChildTracker,
  projectsDir: string,
  options: StartServerChildOptions = {}
): Promise<ServerChildHandle> {
  await assertServerBuilt();
  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = tracker.track(
    spawn(process.execPath, [SERVER_DIST_ENTRY], {
      env: {
        ...process.env,
        PORT: String(port),
        SCADFORGE_PROJECTS_DIR: projectsDir,
        ...(options.faultPoint !== undefined ? { SCADFORGE_FAULT_POINT: options.faultPoint } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
  );

  await waitFor(
    async () => {
      if (!isRunning(child)) {
        throw new Error(
          `server-fault-harness: server child pid=${child.pid ?? "?"} exited before becoming ready ` +
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

  return { child, baseUrl };
}
