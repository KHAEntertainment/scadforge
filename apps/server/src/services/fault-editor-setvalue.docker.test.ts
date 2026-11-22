// SPDX-License-Identifier: Apache-2.0
//
// Fault qualification (Issue #110, S3-B ticket B8, Phase 2) -- the ONE
// `@docker` case: `set-value` crash through B5's REAL proof (a real OpenSCAD
// render, not a stand-in), on the repository clamp fixture, so the
// proof-then-commit path is exercised with the engine actually running.
// Same fixture/binding/flow as `editor-commit.docker.test.ts` (S3-B ticket
// B6's own end-to-end AC) -- reused here rather than re-derived -- but
// through a REAL server child that gets `SIGKILL`ed mid-commit, a restart,
// and a read, instead of one in-process happy-path call.
//
// The kill lands before any HTTP response ever reaches a client, so there is
// no client-held receipt to compare against (unlike the crash-matrix file's
// remove-feature cases, which mint their own proof in-process and so DO
// still hold the request they sent) -- this case's assertions all come from
// the RESTARTED server: the operations endpoint's own well-formed receipt,
// `GET .../editor` reporting that same `editorRevision` and `wall: 5`, and
// root coherence (`project.head` equals the receipt's `snapshotId`).
//
// Needs Docker: `POST .../editor/verify` always compiles the source (a real
// OpenSCAD subprocess) to derive the Customizer schema, and `set-value`'s own
// proof additionally renders 3 real samples through the pinned image
// (CLAUDE.md) -- unlike `remove-feature`, there is no engine-free path here.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initProject, withRecoveredProject, writeSidecarLocked } from "@scadforge/scad-core";
import type { EditorFeature, EditorOperationResponse, EditorVerifyRequest } from "@scadforge/protocol";
import { projectDir } from "./project-paths.js";
import { assertFaultPointEnvClean, assertServerBuilt, createChildTracker, killChild, startServerChild, waitForExit } from "../test-support/server-fault-harness.js";

/** Same probe scad-core's own `test-support/docker-available.ts` uses (not exported across the package boundary) -- mirrors `editor-commit.docker.test.ts`'s own local copy. */
function dockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    return result.status === 0;
  } catch {
    return false;
  }
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLAMP_SCAD_PATH = `${REPO_ROOT}evals/scenario-a2/fixture/clamp.scad`;
const CLAMP_PARAMS = { pipe_dia: 32, wall: 3, width: 20, plate: 4, screw_dia: 4.5 };
const FEATURE_ID = "11111111-1111-4111-8111-111111111111";

/** The exact binding `editor-commit.docker.test.ts`/`proof.docker.test.ts`'s "clamp: linear wall binding (scale-2, centered)" case already proves against this same fixture. */
function wallFeature(projectId: string): EditorFeature {
  return {
    featureId: FEATURE_ID,
    label: "Clamp wall",
    projectId,
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: {
      kind: "linear",
      parameter: "wall",
      axis: "x",
      mapping: { scale: 2, offset: CLAMP_PARAMS.pipe_dia + CLAMP_PARAMS.plate - 1, anchor: "center" }
    }
  };
}

const tracker = createChildTracker();
const tempDirs: string[] = [];

async function freshProjectsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scadserver-fault-editor-docker-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  await assertServerBuilt();
});

beforeEach(() => {
  assertFaultPointEnvClean();
});

afterEach(async () => {
  await tracker.killAll();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!dockerAvailable())("@docker set-value crash through B5's real proof (S3-B ticket B8 Phase 2, Issue #110 AC5)", () => {
  it("verify (real render) then a real-SIGKILL commit; the restarted server shows the committed receipt, wall: 5, and a coherent root", async () => {
    const projectsDir = await freshProjectsDir();
    const clampScad = await readFile(CLAMP_SCAD_PATH, "utf8");

    // Seeded directly via scad-core, not `POST /api/projects` -- that route's
    // `CreateProjectRequest` has no `params` field at all (confirmed while
    // building this test: the clamp fixture's own Customizer defaults never
    // reach root `params.json` through it), so it cannot reproduce the
    // fixture's real starting values the way `editor-commit.docker.test.ts`
    // does. No route can create a feature except an editor command itself
    // either (that test's own established precedent), so both are direct
    // scad-core calls here.
    const projectId = "clamp";
    const dir = projectDir(projectsDir, projectId);
    await mkdir(dir, { recursive: true });
    await initProject(dir, {
      id: projectId,
      name: "Clamp",
      provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
      content: clampScad,
      params: CLAMP_PARAMS,
      message: "Initial snapshot"
    });
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [wallFeature(projectId)] }));

    // 2. A second clean server verifies the set-value command -- a REAL
    // render through Docker, exercising the proof step this case exists
    // to prove.
    const verifying = await startServerChild(tracker, projectsDir, { readyTimeoutMs: 15000 });
    const beforeRes = await fetch(`${verifying.baseUrl}/api/projects/${projectId}/editor`);
    expect(beforeRes.status).toBe(200);
    const before = (await beforeRes.json()) as { editorRevision: string; values: { wall: number } };
    expect(before.values.wall).toBe(3);

    const verifyRequest: EditorVerifyRequest = {
      version: 1,
      baseEditorRevision: before.editorRevision,
      command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 5 },
      intent: "edit",
      traversal: null
    };
    const verifyRes = await fetch(`${verifying.baseUrl}/api/projects/${projectId}/editor/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verifyRequest)
    });
    expect(verifyRes.status).toBe(200);
    const proof = (await verifyRes.json()) as { proofId: string };
    await killChild(verifying.child);

    // 3. A THIRD server, `after-commit` armed on ITS OWN environment only,
    // gets the crashing commit: no response ever reaches this client.
    const operationId = randomUUID();
    const commitRequest = { ...verifyRequest, operationId, proofId: proof.proofId };
    const crashing = await startServerChild(tracker, projectsDir, { faultPoint: "after-commit", readyTimeoutMs: 15000 });
    await expect(
      fetch(`${crashing.baseUrl}/api/projects/${projectId}/editor/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(commitRequest)
      })
    ).rejects.toThrow();
    await waitForExit(crashing.child, 10000);
    expect(crashing.child.signalCode).toBe("SIGKILL"); // positive evidence

    // 4. A FOURTH, clean server restarts against the same projects dir.
    // Every assertion below comes from THIS server -- there is no
    // client-held receipt from the crashed request to compare against.
    const restarted = await startServerChild(tracker, projectsDir, { readyTimeoutMs: 15000 });
    const opRes = await fetch(`${restarted.baseUrl}/api/projects/${projectId}/editor/operations/${operationId}`);
    expect(opRes.status).toBe(200);
    const opBody = (await opRes.json()) as EditorOperationResponse;
    expect(opBody.state).toBe("committed");
    if (opBody.state !== "committed") throw new Error("unreachable");
    expect(opBody.receipt.operationId).toBe(operationId);
    expect(opBody.receipt.values.wall).toBe(5);
    expect(opBody.receipt.editorRevision).not.toBe(before.editorRevision);

    const afterRes = await fetch(`${restarted.baseUrl}/api/projects/${projectId}/editor`);
    expect(afterRes.status).toBe(200);
    const after = (await afterRes.json()) as { editorRevision: string; values: { wall: number }; head: string | null };
    expect(after.values.wall).toBe(5);
    expect(after.editorRevision).toBe(opBody.receipt.editorRevision);

    // Root coherence: the project's head IS the committed receipt's snapshot.
    expect(after.head).toBe(opBody.receipt.snapshotId);

    await killChild(restarted.child);
  }, 90000);
});
