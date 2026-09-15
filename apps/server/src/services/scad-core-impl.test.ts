// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWS } from "@scadforge/scad-core";
import type { RenderResult, RenderedView, SyntaxCheckResult } from "@scadforge/scad-core";
import { RouteError } from "./errors.js";
import { assertCompleteBuildRender, compileProposedSource } from "./scad-core-impl.js";
import type { ServerRuntime } from "./runtime.js";

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
