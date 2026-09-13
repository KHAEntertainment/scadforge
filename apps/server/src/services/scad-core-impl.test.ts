// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VIEWS, createSnapshotLocked, initProject, mergeParamsAtomic } from "@scadforge/scad-core";
import type { RenderResult, RenderedView, SyntaxCheckResult } from "@scadforge/scad-core";
import { RouteError } from "./errors.js";
import { assertCompleteBuildRender, compileProposedSource, createScadCoreApi } from "./scad-core-impl.js";
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
