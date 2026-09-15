// SPDX-License-Identifier: Apache-2.0
//
// @docker -- exercises render_views against the REAL pinned OpenSCAD image.
// Skips automatically when Docker is not reachable (Issue #14 AC).
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VIEWS, VIEW_NAMES } from "../types.js";
import { dockerAvailable, fixture } from "../test-support/docker-available.js";
import { renderViews } from "./render.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "scadcore-render-out-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable())("@docker render_views (real pinned OpenSCAD image)", () => {
  it("renders the default 4 views (iso/front/right/section) at 1024x768", async () => {
    const result = await renderViews({ scadPath: fixture("simple.scad"), outDir });

    expect(result.ok).toBe(true);
    expect(result.views.map((v) => v.view)).toEqual([...DEFAULT_VIEWS]);
    expect(DEFAULT_VIEWS).not.toContain("top"); // Spike 3 §8: top excluded by default

    for (const view of result.views) {
      expect(view.ok).toBe(true);
      expect(view.path).toBe(join(outDir, `${view.view}.png`));
      expect(view.imgsize).toEqual([1024, 768]);
      expect(view.projection).toBe("ortho");
      expect(view.bytes).toBeGreaterThan(0);
      expect(view.render_ms).toBeGreaterThan(0);
      const stats = await stat(view.path!);
      expect(stats.size).toBe(view.bytes);
    }
    expect(result.total_ms).toBeGreaterThan(0);
    console.log(
      `[render_views timing] ${result.views.map((v) => `${v.view}=${v.render_ms.toFixed(1)}ms`).join(" ")} total=${result.total_ms.toFixed(1)}ms`
    );
  }, 60_000);

  it("renders 'top' only on explicit request (Spike 3 §8: near-useless by default)", async () => {
    const result = await renderViews({ scadPath: fixture("simple.scad"), outDir, views: ["top"] });
    expect(result.ok).toBe(true);
    expect(result.views).toHaveLength(1);
    expect(result.views[0].view).toBe("top");
    expect(result.views[0].camera).toBe("0,0,0,0,0,0,0");
  }, 60_000);

  it("renders every one of the 5 fixed views when explicitly requested, matching VIEW_NAMES", async () => {
    const result = await renderViews({ scadPath: fixture("simple.scad"), outDir, views: VIEW_NAMES });
    expect(result.ok).toBe(true);
    expect(result.views.map((v) => v.view)).toEqual([...VIEW_NAMES]);
  }, 60_000);

  it("applies parameter overrides for this render only (not persisted anywhere)", async () => {
    const small = await renderViews({ scadPath: fixture("simple.scad"), outDir, views: ["iso"], params: { size: 5 } });
    expect(small.ok).toBe(true);
    expect(small.views[0].bytes).toBeGreaterThan(0);
  }, 60_000);

  it("honors an imgsize override", async () => {
    const result = await renderViews({ scadPath: fixture("simple.scad"), outDir, views: ["front"], imgsize: [400, 300] });
    expect(result.ok).toBe(true);
    expect(result.views[0].imgsize).toEqual([400, 300]);
  }, 60_000);

  // COUNTEREXAMPLE: a render exceeding its timeout is killed and reported, not hung.
  it("a render whose timeout is exceeded is killed (SIGKILL) and reported as TIMEOUT, degrading gracefully", async () => {
    const result = await renderViews({ scadPath: fixture("simple.scad"), outDir, views: ["iso"], timeoutMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.views[0].ok).toBe(false);
    expect(result.views[0].stderr?.toLowerCase()).toContain("timed out");
    expect(result.error_code).toBe("RENDER_FAILED");
  }, 30_000);

  // COUNTEREXAMPLE: malformed .scad -> the whole render_views degrades gracefully, not an uncaught throw.
  it("malformed .scad source degrades gracefully: ok:false per view with a typed diagnostic, never throws", async () => {
    const result = await renderViews({ scadPath: fixture("bad-syntax.scad"), outDir, views: ["iso"] });
    expect(result.ok).toBe(false);
    expect(result.views[0].ok).toBe(false);
    expect(result.views[0].path).toBeNull();
    expect(result.views[0].stderr).toBeTruthy();
  }, 60_000);
});
