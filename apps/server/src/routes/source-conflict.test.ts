// SPDX-License-Identifier: Apache-2.0
//
// Regression test (Issue #109): a concurrent write landing between
// `updateSource`'s compile (outside the lock) and its in-lock revision
// recheck must surface as 409 CONFLICT through the real HTTP route, never a
// 500 INTERNAL_ERROR. Exercises the REAL `ScadCoreApi`
// (`createScadCoreApi(runtime)`) and the real filesystem store through
// `createApp` -- unlike `source.test.ts`'s fake-backed tests, which never
// reach `compileProposedSource`/`updateSource`'s in-lock recheck at all.
//
// The race is made deterministic (no Docker, no real timing) by partially
// mocking `@scadforge/scad-core`'s `runSyntaxCheck`/`runParamExport`: the
// mocked `runSyntaxCheck` signals it started, then blocks on a gate the test
// controls, pinning the exact moment `updateSource` sits between its initial
// check and its second, in-lock boundary entry. Everything else -- the
// store, `withRecoveredProject`, `createSnapshotLocked`, `ScadCoreApi` -- is
// the real implementation.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotLocked, initProject, listSnapshots, withRecoveredProject } from "@scadforge/scad-core";
import { createApp } from "../app.js";
import { createScadCoreApi } from "../services/scad-core-impl.js";
import { createServerRuntime } from "../services/runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "../services/project-paths.js";
import { createScriptedAgentProvider } from "../test/fakes.js";

const gate = vi.hoisted(() => {
  let resolveStarted!: () => void;
  let resolveGate!: () => void;
  const started = new Promise<void>((r) => (resolveStarted = r));
  const armed = new Promise<void>((r) => (resolveGate = r));
  return { started, armed, resolveStarted: () => resolveStarted(), resolveGate: () => resolveGate() };
});

vi.mock("@scadforge/scad-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scadforge/scad-core")>();
  return {
    ...actual,
    runSyntaxCheck: vi.fn(async () => {
      gate.resolveStarted();
      await gate.armed;
      return { ok: true, errors: [], warnings: [], ms: 1 };
    }),
    runParamExport: vi.fn(async () => ({ title: "", parameters: [] }))
  };
});

describe("PUT /api/projects/:projectId/source -- mid-save conflict (Issue #109)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scadforge-source-conflict-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("a concurrent snapshot landing between compile and the in-lock recheck returns 409 CONFLICT, never 500", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: runtime.provider, content: "cube(1);\n", params: {} });

    const app = createApp({ scadCore: createScadCoreApi(runtime), agent: createScriptedAgentProvider([]) });

    const sourceRes = await app.request("/api/projects/p/source");
    const sourceBody = (await sourceRes.json()) as { revision: string };
    const baseRevision = sourceBody.revision;

    // Kick off the save; the mocked `runSyntaxCheck` signals `gate.started`
    // and then blocks on `gate.armed`, pinning `updateSource` between its
    // initial check (already passed above) and its in-lock recheck.
    const putPromise = app.request("/api/projects/p/source", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scad: "cube(2);", base_revision: baseRevision })
    });

    await gate.started;

    // The concurrent write: a REAL snapshot, landing squarely inside the
    // window the save is blocked in.
    const concurrentSnapshot = await withRecoveredProject(dir, (ctx) =>
      createSnapshotLocked(ctx, { content: "cube(1);\n", params: {}, message: "concurrent write", origin: "manual", pass: null })
    );

    gate.resolveGate();

    const res = await putPromise;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("CONFLICT");

    // updateSource's own commit never landed: the snapshot count is exactly
    // what the concurrent writer left it at, and the concurrent writer's
    // snapshot is still head.
    const snapshotsAfter = await listSnapshots(dir); // store order: oldest first
    expect(snapshotsAfter).toHaveLength(2);
    expect(snapshotsAfter.at(-1)!.id).toBe(concurrentSnapshot.id);
  });
});
