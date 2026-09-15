// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWS,
  createSnapshotLocked,
  editorRevision,
  initProject,
  mergeParamsAtomic,
  withRecoveredProject,
  writeSidecarLocked
} from "@scadforge/scad-core";
import type { RenderResult, RenderedView, SyntaxCheckResult } from "@scadforge/scad-core";
import type { EditorFeature, EditorSidecar } from "@scadforge/protocol";
import { RouteError } from "./errors.js";
import { assertCompleteBuildRender, coherentSourceState, compileProposedSource, createScadCoreApi } from "./scad-core-impl.js";
import { createServerRuntime, type ServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

function view(view: RenderedView["view"], ok: boolean): RenderedView {
  return {
    view,
    ok,
    path: ok ? `/tmp/${view}.png` : null,
    camera: "",
    projection: "ortho",
    imgsize: [256, 256],
    bytes: ok ? 1 : null,
    render_ms: 1,
    stderr: ok ? null : `${view} failed`
  };
}

describe("studio build backend guards", () => {
  it("rejects a partial render set before attachments can be persisted", () => {
    const result: RenderResult = {
      ok: false,
      views: DEFAULT_VIEWS.map((name, index) => view(name, index !== 1)),
      total_ms: 2,
      error_code: "RENDER_FAILED",
      message: "render_views: 1 of 4 view(s) failed"
    };

    expect(() => assertCompleteBuildRender(result)).toThrowError(
      expect.objectContaining({ code: "RENDER_FAILED" })
    );
  });

  it("accepts only a complete successful render set", () => {
    const result: RenderResult = { ok: true, views: DEFAULT_VIEWS.map((name) => view(name, true)), total_ms: 2 };
    expect(() => assertCompleteBuildRender(result)).not.toThrow();
  });

  it("propagates Customizer export failures instead of returning an empty schema", async () => {
    const runtime = { libraryPaths: [] } as unknown as ServerRuntime;
    const syntax: SyntaxCheckResult = { ok: true, errors: [], warnings: [], ms: 1 };

    await expect(
      compileProposedSource(runtime, "cube([1, 1, 1]);\n", {
        syntaxCheck: async () => syntax,
        paramExport: async () => {
          throw new RouteError("RENDER_FAILED", "param export unavailable");
        }
      })
    ).rejects.toMatchObject({ code: "RENDER_FAILED", message: "param export unavailable" });
  });
});

// ── Issue #73 AC9: projectResponse coherence under a concurrent slow writer ──
//
// No OpenSCAD/Docker involved -- `getProject` never invokes the CLI, so this
// is a plain filesystem-timing test.
describe("projectResponse coherence under a concurrent slow writer (Issue #73 AC9)", () => {
  let root: string;
  const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scadforge-project-response-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("every concurrent getProject read is internally coherent -- never a head from one write paired with scad/params from another", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    const OLD_CONTENT = "cube([10,10,10]);\n";
    const NEW_CONTENT = "cube([20,20,20]);\n";
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: OLD_CONTENT, params: {} });

    const api = createScadCoreApi(runtime);

    // A slow writer: holds the recovery boundary for 60ms while producing a
    // brand-new snapshot with different content AND params -- long enough
    // that several concurrent reads are guaranteed to land squarely inside
    // its critical section if the boundary did not serialize them.
    const slowWrite = mergeParamsAtomic(dir, { tag: "new" }, async (merged, ctx) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      return createSnapshotLocked(ctx, {
        content: NEW_CONTENT,
        params: merged,
        message: "slow concurrent write",
        origin: "manual",
        pass: null
      });
    });

    // Fire a burst of reads that overlap the slow writer's critical section.
    const reads = Array.from({ length: 8 }, () => api.getProject("p"));

    const [, ...results] = await Promise.all([slowWrite, ...reads]);

    for (const response of results) {
      expect(response.head).not.toBeNull();
      if (response.head!.id === "0001") {
        // Observed strictly BEFORE the slow write committed -- every field
        // must agree with the OLD state, never a partial peek at the new one.
        expect(response.scad).toBe(OLD_CONTENT);
        expect(response.params.tag).toBeUndefined();
      } else {
        // Observed strictly AFTER the slow write committed.
        expect(response.head!.id).toBe("0002");
        expect(response.scad).toBe(NEW_CONTENT);
        expect(response.params.tag).toBe("new");
      }
    }
  });
});

// ── coherentSourceState carries the editor sidecar (Issue #87 / S3-B ticket B3, AC9) ──
//
// No wire response changes -- this only proves the INTERNAL coherent-read
// result carries the sidecar fields B5/B6/B7 will consume.
describe("coherentSourceState internal sidecar fields (Issue #87)", () => {
  let root: string;
  const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "scadforge-coherent-source-state-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

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

  it("a brand-new project (S3-modern from its first snapshot) reads ready with an empty feature list and a non-null editor revision", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const state = await coherentSourceState(dir);

    expect(state.sidecarStatus).toBe("ready");
    expect(state.sidecarFeatures).toEqual([]);
    expect(state.sidecarDigest).not.toBeNull();
    expect(state.editorRevision).toBe(editorRevision(state.revision, state.sidecarDigest!));
  });

  it("a sidecar write changes editorRevision without changing revision (source untouched)", async () => {
    const runtime = createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: root } as NodeJS.ProcessEnv);
    const dir = runtime.dirFor("p");
    await initProject(dir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });

    const before = await coherentSourceState(dir);
    const sidecar: EditorSidecar = { version: 1, features: [feature()] };
    await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, sidecar));
    const after = await coherentSourceState(dir);

    expect(after.revision).toBe(before.revision);
    expect(after.editorRevision).not.toBe(before.editorRevision);
    expect(after.sidecarFeatures.map((f) => f.featureId)).toEqual([sidecar.features[0].featureId]);
  });
});
