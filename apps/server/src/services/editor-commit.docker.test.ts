// SPDX-License-Identifier: Apache-2.0
//
// @docker -- S3-B ticket B6's required end-to-end AC (Issue #98): verify,
// then commit, a scale-2 clamp wall change against the repository clamp
// fixture, through the REAL server API (`createScadCoreApi`, real Docker
// OpenSCAD render for the proof) -- `GET .../editor` then shows the new
// value and revision. The binding (scale 2, offset = pipe_dia + plate - 1,
// anchor "center") is the exact one `packages/scad-core/src/editor/
// proof.docker.test.ts`'s "clamp: linear wall binding (scale-2, centered)"
// case already proves against this same fixture -- reused here rather than
// re-derived, so this test exercises the SERVER PLUMBING around an
// already-proven geometry relation, not the recognizer itself.
//
// Needs Docker: `verifyEditorCommand` renders 3 real samples through the
// pinned OpenSCAD image (CLAUDE.md).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, withRecoveredProject, writeSidecarLocked } from "@scadforge/scad-core";
import type { EditorFeature, EditorVerifyRequest } from "@scadforge/protocol";
import { createScadCoreApi } from "./scad-core-impl.js";
import { createServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

/** Same probe scad-core's own `test-support/docker-available.ts` uses (not exported across the package boundary). */
function dockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLAMP_SCAD_PATH = `${REPO_ROOT}evals/scenario-a2/fixture/clamp.scad`;

// The clamp fixture's own Customizer defaults (evals/scenario-a2/fixture/clamp.scad).
const CLAMP_PARAMS = { pipe_dia: 32, wall: 3, width: 20, plate: 4, screw_dia: 4.5 };

// A real UUID, unlike proof.docker.test.ts's "wall-feature" -- that test
// calls runProbe directly, in-memory, never through the wire parser this
// server-level test's writeSidecarLocked -> readSidecarLocked round trip
// DOES enforce (parseEditorSidecar's expectUuid on featureId).
const FEATURE_ID = "11111111-1111-4111-8111-111111111111";

/** The exact binding `proof.docker.test.ts`'s "clamp: linear wall binding (scale-2, centered)" case proves: the fused clamp+backplate solid's X extent is `2*(pipe_dia/2+wall) + plate - 1`, so scale 2 on `wall`, offset `pipe_dia+plate-1`, anchor "center". */
function wallFeature(): EditorFeature {
  return {
    featureId: FEATURE_ID,
    label: "Clamp wall",
    projectId: "clamp",
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

let root: string;

function runtimeFor(dir: string) {
  return createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: dir } as NodeJS.ProcessEnv);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scadforge-editor-commit-docker-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedClampProject(id = "clamp") {
  const runtime = runtimeFor(root);
  const dir = runtime.dirFor(id);
  const content = await readFile(CLAMP_SCAD_PATH, "utf8");
  await initProject(dir, { id, name: "Clamp", provider: runtime.provider, content, params: CLAMP_PARAMS, message: "Initial snapshot" });
  // The route surface has no way to CREATE a feature except through the
  // editor command path itself -- seeding one directly here isolates this
  // test to exactly the AC it proves (verify -> commit a set-value ->
  // GET shows the change), not put-feature's own separately-tested rules.
  await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, { version: 1, features: [wallFeature()] }));
  return { runtime, dir };
}

describe.skipIf(!dockerAvailable())("@docker editor commit end-to-end (S3-B ticket B6, Issue #98)", () => {
  it("verify then commit a scale-2 clamp wall change; GET .../editor shows the new value and revision", async () => {
    const { runtime } = await seedClampProject();
    const api = createScadCoreApi(runtime);

    const before = await api.getEditorDocument("clamp");
    expect(before.values.wall).toBe(3);
    expect(before.sidecarStatus).toBe("ready");
    expect(before.sidecar.features).toHaveLength(1);

    const verifyRequest: EditorVerifyRequest = {
      version: 1,
      baseEditorRevision: before.editorRevision,
      command: { kind: "set-value", featureId: FEATURE_ID, bindingVersion: 1, value: 5 },
      intent: "edit",
      traversal: null
    };
    const proof = await api.verifyEditorCommand("clamp", verifyRequest);
    expect(proof.baseEditorRevision).toBe(before.editorRevision);

    const receipt = await api.submitEditorCommand("clamp", {
      ...verifyRequest,
      operationId: randomUUID(),
      proofId: proof.proofId
    });
    expect(receipt.values.wall).toBe(5);
    expect(receipt.editorRevision).not.toBe(before.editorRevision);

    const after = await api.getEditorDocument("clamp");
    expect(after.values.wall).toBe(5);
    expect(after.editorRevision).toBe(receipt.editorRevision);
    expect(after.editorRevision).not.toBe(before.editorRevision);
    expect(after.head).toBe(receipt.snapshotId);
  }, 60000);
});
