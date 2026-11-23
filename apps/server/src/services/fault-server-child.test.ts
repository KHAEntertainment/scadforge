// SPDX-License-Identifier: Apache-2.0
//
// Fault qualification (Issue #99, S3-B ticket B8, Phase 1) -- server-child
// mode. Proves the one HTTP-level case Phase 1 requires: a `PUT
// .../params` request killed by a REAL server `SIGKILL` after `commit.json`
// is durable but before the HTTP response ever goes out, a server restart,
// and a plain read confirming the write survived and rolled forward.
//
// The process-spawning helpers live in `../test-support/server-fault-
// harness.ts` (extracted here, C6 correction on Issue #110, so Phase 2's
// server-crash test files do not triplicate them).
//
// `GET /api/projects/:projectId` (not `GET .../params`) is the read used
// here: `projectResponse` is a pure filesystem read (no OpenSCAD subprocess),
// while `paramsResponse` calls `runParamExport` (a real OpenSCAD/Docker
// call) to derive the live Customizer schema -- Phase 1 needs no engine.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreateProjectRequest, ProjectResponse } from "@scadforge/protocol";
import {
  assertFaultPointEnvClean,
  assertServerBuilt,
  createChildTracker,
  killChild,
  startServerChild,
  waitForExit
} from "../test-support/server-fault-harness.js";

const tracker = createChildTracker();
let projectsDir: string;

beforeAll(async () => {
  await assertServerBuilt();
});

beforeEach(async () => {
  assertFaultPointEnvClean(); // redundant with the module-load-time absence of the var, on purpose (C1)
  projectsDir = await mkdtemp(join(tmpdir(), "scadserver-fault-child-"));
});

afterEach(async () => {
  await tracker.killAll(); // C5: a real hygiene proof -- see server-fault-harness.ts's module header
  await rm(projectsDir, { recursive: true, force: true });
});

describe("server-child mode: PUT /params killed after commit.json, restart, read", () => {
  it("the committed write survives a real SIGKILL mid-request and is visible after restart", async () => {
    // 1. A clean server creates the project.
    const setup = await startServerChild(tracker, projectsDir);
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
    const crashing = await startServerChild(tracker, projectsDir, { faultPoint: "after-commit" });
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
    const restarted = await startServerChild(tracker, projectsDir);
    const readRes = await fetch(`${restarted.baseUrl}/api/projects/${projectId}`);
    expect(readRes.status).toBe(200);
    const project = (await readRes.json()) as ProjectResponse;
    expect(project.params).toEqual({ k: 99 });
    expect(project.head?.origin).toBe("manual");
    await killChild(restarted.child);
  }, 30000);
});
