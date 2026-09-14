// SPDX-License-Identifier: GPL-3.0-or-later
//
// Issue #87 (S3-B ticket B3): the agent's `coherentProjectState` internal
// coherent-read result carries the editor sidecar's status/features/digest
// and the resulting editor revision -- an internal-only extension. No wire
// change: `readProject()`'s returned `ProjectState` is asserted unchanged.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, withRecoveredProject, writeSidecarLocked } from "@scadforge/scad-core";
import type { EditorFeature, EditorSidecar } from "@scadforge/protocol";
import { coherentProjectState, createAgentScadCore } from "./agent-scad-core.js";
import { createServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

let root: string;
const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scadforge-agent-scad-core-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runtimeFor(dir: string) {
  return createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: dir } as NodeJS.ProcessEnv);
}

function feature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: randomUUID(),
    label: "Width",
    projectId: randomUUID(),
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "width", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
    ...overrides
  };
}

describe("coherentProjectState (Issue #87 / S3-B ticket B3)", () => {
  it("a brand-new project (S3-modern from its first snapshot) reads ready with an empty feature list and a non-null editor revision", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const state = await coherentProjectState(dir);

    expect(state.sidecarStatus).toBe("ready");
    expect(state.sidecarFeatures).toEqual([]);
    expect(state.sidecarDigest).not.toBeNull();
    expect(state.editorRevision).not.toBeNull();
  });

  it("a sidecar write changes the internal editor revision and is reflected in sidecarFeatures", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const before = await coherentProjectState(dir);
    const sidecar: EditorSidecar = { version: 1, features: [feature()] };
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, sidecar));
    const after = await coherentProjectState(dir);

    expect(after.editorRevision).not.toBe(before.editorRevision);
    expect(after.sidecarFeatures.map((f) => f.featureId)).toEqual([sidecar.features[0].featureId]);
  });

  it("readProject()'s wire ProjectState is unchanged -- no sidecar fields leak onto it", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });
    const agentCore = createAgentScadCore({ runtime, projectId: "p" });

    const projectState = await agentCore.readProject();

    expect(Object.keys(projectState).sort()).toEqual(
      ["head_snapshot", "param_schema", "params", "scad", "validation"].sort()
    );
  });
});
