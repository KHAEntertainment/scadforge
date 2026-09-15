// SPDX-License-Identifier: GPL-3.0-or-later
//
// Issue #87 (S3-B ticket B3): the agent's `coherentProjectState` internal
// coherent-read result carries the editor sidecar's status/features/digest
// and the resulting editor revision -- an internal-only extension. No wire
// change: `readProject()`'s returned `ProjectState` is asserted unchanged.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeSourceRevision,
  initProject,
  metaDir,
  projectFilePath,
  rootParamsPath,
  withRecoveredProject,
  writeSidecarLocked
} from "@scadforge/scad-core";
import type { EditorFeature, EditorSidecar } from "@scadforge/protocol";
import { PassBudget, ToolActivityRecorder, createToolHandlers, testing } from "@scadforge/agent";
import { coherentProjectState, createAgentScadCore } from "./agent-scad-core.js";
import { createServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

const HEX64_RE = /^[0-9a-f]{64}$/;

/** `.scadforge/editor.json` -- mirrors `sidecar.ts`'s private `SIDECAR_FILE_NAME` (not exported from the package barrel). */
function rootSidecarPath(dir: string): string {
  return join(metaDir(dir), "editor.json");
}

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

  it("readProject()'s wire ProjectState now legitimately carries editor (Issue #92 / S3-B ticket B7) -- otherwise unchanged", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const projectState = await agentCore.readProject();

    expect(Object.keys(projectState).sort()).toEqual(
      ["editor", "head_snapshot", "param_schema", "params", "scad", "validation"].sort()
    );
  });
});

describe("readProject() editor block (Issue #92 / S3-B ticket B7)", () => {
  it("a fresh project reads a ready block with an empty feature list and a real (non-fallback) editorRevision", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const { editor } = await agentCore.readProject();

    expect(editor).toBeDefined();
    expect(editor?.version).toBe(1);
    expect(editor?.projectId).toBe("my-bracket");
    expect(editor?.sidecarStatus).toBe("ready");
    expect(editor?.features).toEqual([]);
    expect(editor?.eligibility).toEqual([]);
    expect(editor?.sourceRevision).toMatch(HEX64_RE);
    expect(editor?.sourceFingerprint).toMatch(HEX64_RE);
    expect(editor?.editorRevision).toMatch(HEX64_RE);
    // Not the missing/corrupt/unsupported-version fallback -- a ready sidecar
    // must use the real digest-folded revision.
    expect(editor?.editorRevision).not.toBe(editor?.sourceRevision);
  });

  it("a ready sidecar with two features reports them (and their real eligibility, Issue #91 / S3-B ticket B5) in featureId order, not insertion order", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    // No Customizer parameters declared, so the compiled schema is empty --
    // `feature()`'s default binding (parameter "width") is legitimately
    // unsupported here (real editorEligibility, not the stand-in, which
    // always reported "requires-proof" regardless of the schema).
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    // Deliberately inserted in DESCENDING featureId order.
    const high = feature({ featureId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    const low = feature({ featureId: "11111111-1111-4111-8111-111111111111" });
    const sidecar: EditorSidecar = { version: 1, features: [high, low] };
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, sidecar));

    const { editor } = await agentCore.readProject();

    expect(editor?.features.map((f) => f.featureId)).toEqual([low.featureId, high.featureId]);
    expect(editor?.eligibility).toEqual([
      { featureId: low.featureId, state: "unsupported", reason: 'Parameter "width" is not in the current parameter schema.' },
      { featureId: high.featureId, state: "unsupported", reason: 'Parameter "width" is not in the current parameter schema.' }
    ]);
  });

  it("a ready sidecar feature bound to a real Customizer parameter reports requires-proof (real eligibility)", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "width = 20; // [5:50]\ncube([width, 10, 10]);\n" });
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const sidecar: EditorSidecar = { version: 1, features: [feature()] };
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, sidecar));

    const { editor } = await agentCore.readProject();

    expect(editor?.eligibility).toEqual([{ featureId: sidecar.features[0].featureId, state: "requires-proof", reason: null }]);
  });

  it("a legacy (pre-S3) project reads legacy-empty with an empty feature list", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    // Simulate a pre-S3 project: strip the marker `initProject`'s first
    // snapshot already set, mirroring `sidecar.test.ts`'s own convention for
    // hand-building a legacy manifest rather than reaching into store.ts.
    const manifestPath = projectFilePath(dir);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.editor_store_version;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const { editor } = await agentCore.readProject();

    expect(editor?.sidecarStatus).toBe("legacy-empty");
    expect(editor?.features).toEqual([]);
    expect(editor?.eligibility).toEqual([]);
    // legacy-empty is trustworthy (B3: "a legacy project has no sidecar at
    // all, so 'empty' is not a fabrication") -- the real digest-folded
    // revision applies, not the missing/corrupt/unsupported-version fallback.
    expect(editor?.editorRevision).not.toBe(editor?.sourceRevision);
  });

  it("a corrupt root sidecar reads corrupt with an empty feature list and editorRevision falling back to sourceRevision", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    await writeFile(rootSidecarPath(dir), "{ not json", "utf8");
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const { editor } = await agentCore.readProject();

    expect(editor?.sidecarStatus).toBe("corrupt");
    expect(editor?.features).toEqual([]);
    expect(editor?.eligibility).toEqual([]);
    expect(editor?.editorRevision).toBe(editor?.sourceRevision);
  });

  it("a missing root sidecar (modern marker, no file) reads missing with an empty feature list and editorRevision falling back to sourceRevision", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    await rm(rootSidecarPath(dir));
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const { editor } = await agentCore.readProject();

    expect(editor?.sidecarStatus).toBe("missing");
    expect(editor?.features).toEqual([]);
    expect(editor?.eligibility).toEqual([]);
    expect(editor?.editorRevision).toBe(editor?.sourceRevision);
  });

  it("an unsupported future sidecar version reads unsupported-version with an empty feature list and editorRevision falling back to sourceRevision", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    await writeFile(rootSidecarPath(dir), JSON.stringify({ version: 2 }), "utf8");
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const { editor } = await agentCore.readProject();

    expect(editor?.sidecarStatus).toBe("unsupported-version");
    expect(editor?.features).toEqual([]);
    expect(editor?.eligibility).toEqual([]);
    expect(editor?.editorRevision).toBe(editor?.sourceRevision);
  });

  it("the whole read fails when the root params authority is corrupt -- never a fabricated empty editor block", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    await writeFile(rootParamsPath(dir), "{ not json", "utf8");
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    await expect(agentCore.readProject()).rejects.toThrow();
  });

  it("a concurrent write_scad while read_project runs never yields a block whose sourceRevision disagrees with the returned scad", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, { id: "my-bracket", name: "n", provider: providerConfig, content: "cube(1);\n" });
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const [reads] = await Promise.all([
      Promise.all(Array.from({ length: 8 }, () => agentCore.readProject())),
      agentCore.writeScad({ content: "cube(2);\n", message: "grow", pass: 1 }),
      agentCore.writeScad({ content: "cube(3);\n", message: "grow again", pass: 2 })
    ]);

    for (const state of reads) {
      expect(state.editor).toBeDefined();
      const recomputed = computeSourceRevision(state.head_snapshot, state.scad, state.params);
      expect(state.editor?.sourceRevision).toBe(recomputed);
    }
  });

  it("a set_params call changes the editor revision the next read_project reports", async () => {
    const runtime = runtimeFor(root);
    const dir = runtime.dirFor("my-bracket");
    await initProject(dir, {
      id: "my-bracket",
      name: "n",
      provider: providerConfig,
      content: "width = 10;\ncube([width, 1, 1]);\n"
    });
    const agentCore = createAgentScadCore({ runtime, projectId: "my-bracket" });

    const before = await agentCore.readProject();
    await agentCore.setParams({ width: 20 }, 0);
    const after = await agentCore.readProject();

    expect(after.editor?.editorRevision).not.toBe(before.editor?.editorRevision);
    expect(after.editor?.sourceRevision).not.toBe(before.editor?.sourceRevision);
  });
});

describe("old-adapter editor omission path (packages/agent handler forwarding, Issue #92)", () => {
  it("createToolHandlers's read_project forwards no editor key when the injected ScadCoreApi omits it", async () => {
    // `testing.MockScadCore` does not implement `readProject().editor` at
    // all -- exactly the "old fake adapter" the AC describes -- exercised
    // here (not in packages/agent/src/tools/handlers.test.ts, out of this
    // ticket's ownership) so the omission-forwarding interaction B3 already
    // wired into handlers.ts stays covered without touching that file or its
    // test beyond the one comment this ticket is scoped to.
    const scadCore = new testing.MockScadCore();
    const libraries = new testing.MockLibraryIndex();
    const budget = new PassBudget({ maxPasses: 2 });
    const activity = new ToolActivityRecorder();
    const handlers = createToolHandlers({
      scadCore,
      libraries,
      budget,
      activity,
      turnId: "turn-1",
      projectId: "my-bracket",
      emit: () => {}
    });

    const result = await handlers.read_project({});

    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect("editor" in payload).toBe(false);
  });
});
