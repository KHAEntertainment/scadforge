// SPDX-License-Identifier: Apache-2.0
//
// Fault qualification (Issue #99, S3-B ticket B8, Phase 1) -- server-child
// mode. Proves the one HTTP-level case Phase 1 requires: a `PUT
// .../params` request killed by a REAL server `SIGKILL` after `commit.json`
// is durable but before the HTTP response ever goes out, a server restart,
// and a plain read confirming the write survived and rolled forward.
//
// This does NOT import `packages/scad-core/src/test-support/fault-
// harness.ts` -- that file lives under scad-core's OWN `rootDir` ("src"),
// and this package's `tsconfig.json` (`rootDir: "src"`) refuses to compile a
// module graph that reaches outside it (`tsc` TS6059, confirmed while
// designing this file). The handful of process-spawning helpers this test
// needs (reserve a free port, spawn the built server, poll for readiness,
// wait for exit) are duplicated locally, mirroring this package's own
// existing precedent -- `params-update.docker.test.ts`/`source-
// build.docker.test.ts`/`snapshot-immutability.docker.test.ts` already spawn
// real child processes directly rather than reaching into scad-core for it.
//
// `GET /api/projects/:projectId` (not `GET .../params`) is the read used
// here: `projectResponse` is a pure filesystem read (no OpenSCAD subprocess),
// while `paramsResponse` calls `runParamExport` (a real OpenSCAD/Docker
// call) to derive the live Customizer schema -- Phase 1 needs no engine.

import { type ChildProcess, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreateProjectRequest, ProjectResponse } from "@scadforge/protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/server/src/services/` -> `apps/server/dist/index.js`. */
const SERVER_DIST_ENTRY = join(HERE, "..", "..", "dist", "index.js");

async function assertServerBuilt(): Promise<void> {
  try {
    await access(SERVER_DIST_ENTRY, fsConstants.F_OK);
  } catch {
    throw new Error(`fault-server-child: required build artifact missing at '${SERVER_DIST_ENTRY}' -- run \`pnpm -r build\` first.`);
  }
}

/** C1 (Issue #99 plan correction): SCADFORGE_FAULT_POINT must never be set on this (the test runner's) own process. */
function assertFaultPointEnvClean(): void {
  if (process.env.SCADFORGE_FAULT_POINT !== undefined) {
    throw new Error(
      "fault-server-child: SCADFORGE_FAULT_POINT is set on this (the test runner's) own process " +
        "environment -- it must be set ONLY on a spawned server child's env, never here."
    );
  }
}

/** C2: reserve a real free port in the parent -- `apps/server` prints the port it was CONFIGURED with, not the one it bound, so `PORT=0` cannot be polled for readiness. */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        server.close();
        reject(new Error("fault-server-child: could not read a bound address while reserving a free port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolvePromise(port)));
    });
  });
}

interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description: string;
}

/** Bounded polling -- never a fixed sleep as synchronization. */
async function waitFor(check: () => Promise<boolean> | boolean, options: WaitForOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`fault-server-child: condition '${options.description}' was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, intervalMs));
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForExit(child: ChildProcess, timeoutMs = 10000): Promise<ExitInfo> {
  if (!isRunning(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fault-server-child: child pid=${child.pid ?? "?"} did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

interface ServerChildHandle {
  child: ChildProcess;
  baseUrl: string;
}

// C5: every spawned child tracked here is killed and awaited in `afterEach`,
// even on assertion failure.
const trackedChildren: ChildProcess[] = [];

async function startServerChild(projectsDir: string, faultPoint?: string): Promise<ServerChildHandle> {
  await assertServerBuilt();
  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_DIST_ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      SCADFORGE_PROJECTS_DIR: projectsDir,
      ...(faultPoint !== undefined ? { SCADFORGE_FAULT_POINT: faultPoint } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  trackedChildren.push(child);

  await waitFor(
    async () => {
      if (!isRunning(child)) {
        throw new Error(
          `fault-server-child: server child pid=${child.pid ?? "?"} exited before becoming ready ` +
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
    { timeoutMs: 10000, intervalMs: 50, description: `server child ${baseUrl}/api/health` }
  );

  return { child, baseUrl };
}

async function killChild(child: ChildProcess): Promise<void> {
  if (!isRunning(child)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 5000).catch(() => {});
}

let projectsDir: string;

beforeAll(async () => {
  await assertServerBuilt();
});

beforeEach(async () => {
  assertFaultPointEnvClean(); // redundant with the module-load-time absence of the var, on purpose (C1)
  projectsDir = await mkdtemp(join(tmpdir(), "scadserver-fault-child-"));
});

afterEach(async () => {
  await Promise.all(trackedChildren.splice(0).map((child) => killChild(child)));
  const running = trackedChildren.filter(isRunning);
  expect(running).toEqual([]); // C5: the actual hygiene proof
  await rm(projectsDir, { recursive: true, force: true });
});

describe("server-child mode: PUT /params killed after commit.json, restart, read", () => {
  it("the committed write survives a real SIGKILL mid-request and is visible after restart", async () => {
    // 1. A clean server creates the project.
    const setup = await startServerChild(projectsDir);
    const createBody: CreateProjectRequest = { name: "fault-server-child", scad: "cube(1);" };
    const createRes = await fetch(`${setup.baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody)
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as ProjectResponse;
    const projectId = created.project.id;
    await killChild(setup.child);

    // 2. A SECOND server, with `after-commit` armed on ITS OWN environment
    // ONLY (never this test runner's process -- `assertFaultPointEnvClean`
    // above), gets the crashing PUT: the request never receives a response,
    // and the real server process dies mid-flight.
    const crashing = await startServerChild(projectsDir, "after-commit");
    await expect(
      fetch(`${crashing.baseUrl}/api/projects/${projectId}/params`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { k: 99 }, snapshot: true })
      })
    ).rejects.toThrow();
    await waitForExit(crashing.child, 10000);
    expect(crashing.child.signalCode).toBe("SIGKILL");

    // 3. A THIRD, clean server restarts against the SAME projects dir. Its
    // first request triggers recovery; the committed write rolls forward and
    // is visible through an ordinary, engine-free read.
    const restarted = await startServerChild(projectsDir);
    const readRes = await fetch(`${restarted.baseUrl}/api/projects/${projectId}`);
    expect(readRes.status).toBe(200);
    const project = (await readRes.json()) as ProjectResponse;
    expect(project.params).toEqual({ k: 99 });
    expect(project.head?.origin).toBe("manual");
    await killChild(restarted.child);
  }, 30000);
});
