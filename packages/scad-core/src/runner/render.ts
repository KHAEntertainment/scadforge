// @scadforge/scad-core — render_views: the fixed 4-view render + the
// two-pass section view, over the pinned OpenSCAD image.
//
// Reimplemented production-grade from Spike 2's `run-views.mjs` harness
// (docs/spikes/02-docker-cli); not imported from spikes/. Every camera/flag
// constant comes from the FROZEN `../types.ts` contract — nothing here
// re-derives or "tidies" those numbers.
//
// SPDX-License-Identifier: Apache-2.0

import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_BACKEND,
  DEFAULT_COLORSCHEME,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_PROJECTION,
  DEFAULT_RENDER_TIMEOUT_MS,
  DEFAULT_VIEWS,
  SECTION_VIEW_CONTRACT,
  SECTION_WRAPPER_MESH_TOKEN,
  SECTION_WRAPPER_TEMPLATE,
  VIEW_CAMERA_ARGS
} from "../types.js";
import type { RenderRequest, RenderResult, RenderedView, ViewName } from "../types.js";
import { ScadForgeError } from "../errors.js";
import { filterOpenscadDiagnostics, runOpenscad } from "./docker.js";
import { writeOverrideParamsFile } from "./params-file.js";
import { stageWork } from "./workdir.js";

/** The section pass-1 mesh file, inside the container's `/work`. */
const SECTION_MESH_FILE = `__section_mesh.${SECTION_VIEW_CONTRACT.meshFormat}`;
/** The generated section wrapper `.scad`, inside the container's `/work`. */
const SECTION_WRAPPER_FILE = "__section_wrapper.scad";

/**
 * `--render=true`, not bare `--render`: verified empirically against the
 * pinned image (docker.io/openscad/openscad@sha256:0af06...) that
 * boost::program_options treats `--render` as a value-taking option and
 * swallows whatever argv token follows it as that value — harmless when
 * another `--flag` follows (as in `RENDER_COMMON_FLAGS`'s own ordering,
 * `--render --colorscheme=...`), but it silently eats the positional
 * `model.scad` path whenever `--render` is the last flag before it (as in
 * the section view's mesh-export pass, which has no camera/colorscheme
 * flags after it), producing OpenSCAD's usage/help text instead of a
 * render. `--render=true` is unambiguous in every position and functionally
 * identical to the frozen contract's bare `--render` token.
 */
const RENDER_FLAG = "--render=true";

function commonFlags(imgsize: readonly [number, number]): string[] {
  return [
    "--viewall",
    "--autocenter",
    `--projection=${DEFAULT_PROJECTION}`,
    `--imgsize=${imgsize[0]},${imgsize[1]}`,
    `--backend=${DEFAULT_BACKEND}`,
    RENDER_FLAG,
    `--colorscheme=${DEFAULT_COLORSCHEME}`
  ];
}

interface ViewOutcome {
  entry: RenderedView;
}

async function renderOneView(
  view: ViewName,
  args: {
    dir: string;
    inputName: string;
    imgsize: readonly [number, number];
    timeoutMs: number;
    overrideArgs: string[];
  }
): Promise<ViewOutcome> {
  const outRel = `views/${view}.png`;
  const camera = VIEW_CAMERA_ARGS[view];
  const dockerArgs = [
    "-o",
    `/work/${outRel}`,
    `--camera=${camera}`,
    ...commonFlags(args.imgsize),
    ...args.overrideArgs,
    `/work/${args.inputName}`
  ];

  try {
    const { ms, stderr } = await runOpenscad(dockerArgs, { cwd: args.dir, timeoutMs: args.timeoutMs });
    const outPath = join(args.dir, outRel);
    let bytes: number | null = null;
    try {
      bytes = (await stat(outPath)).size;
    } catch {
      bytes = null;
    }
    return {
      entry: {
        view,
        ok: bytes !== null && bytes > 0,
        path: bytes !== null && bytes > 0 ? outPath : null,
        camera,
        projection: "ortho",
        imgsize: args.imgsize,
        bytes,
        render_ms: ms,
        stderr: filterOpenscadDiagnostics(stderr)
      }
    };
  } catch (err) {
    const typed = ScadForgeError.normalize(err, "RENDER_FAILED", `render_views: view '${view}' failed`);
    return {
      entry: {
        view,
        ok: false,
        path: null,
        camera,
        projection: "ortho",
        imgsize: args.imgsize,
        bytes: null,
        render_ms: 0,
        stderr: typed.message
      }
    };
  }
}

/**
 * `render_views` — renders the requested (default: {@link DEFAULT_VIEWS}) set
 * of fixed views for a `.scad` model, returning one PNG per view plus the
 * two-pass `section` view. Individual view failures degrade gracefully: `ok`
 * is false for that view and rendering continues for the rest (the whole
 * result's `ok` is true only when every requested view succeeded).
 */
export async function renderViews(
  request: RenderRequest,
  options?: { libraryPaths?: readonly string[] }
): Promise<RenderResult> {
  const views = request.views ?? DEFAULT_VIEWS;
  const imgsize = request.imgsize ?? DEFAULT_IMAGE_SIZE;
  const timeoutMs = request.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const start = process.hrtime.bigint();

  const work = await stageWork(request.scadPath, { libraryPaths: options?.libraryPaths });
  try {
    const overrideArgs = await writeOverrideParamsFile(work.dir, request.params);
    const renderedViews: RenderedView[] = [];

    for (const view of views) {
      if (view === "section") continue; // handled separately below (two-pass)
      const { entry } = await renderOneView(view, {
        dir: work.dir,
        inputName: work.modelName,
        imgsize,
        timeoutMs,
        overrideArgs
      });
      renderedViews.push(entry);
    }

    if (views.includes("section")) {
      renderedViews.push(await renderSection(work.dir, work.modelName, imgsize, timeoutMs, overrideArgs));
    }

    // Preserve the caller's requested order.
    const byView = new Map(renderedViews.map((v) => [v.view, v] as const));
    const ordered = views.map((v) => byView.get(v)).filter((v): v is RenderedView => v !== undefined);

    // Copy successful PNGs out to the caller's outDir before the temp dir is cleaned up.
    await copyRenderedOut(ordered, request.outDir);

    const total_ms = Number(process.hrtime.bigint() - start) / 1e6;
    const ok = ordered.length === views.length && ordered.every((v) => v.ok);
    return ok
      ? { ok: true, views: ordered, total_ms }
      : {
          ok: false,
          views: ordered,
          total_ms,
          error_code: "RENDER_FAILED",
          message: `render_views: ${ordered.filter((v) => !v.ok).length} of ${views.length} view(s) failed`
        };
  } finally {
    await work.cleanup();
  }
}

async function renderSection(
  dir: string,
  inputName: string,
  imgsize: readonly [number, number],
  timeoutMs: number,
  overrideArgs: string[]
): Promise<RenderedView> {
  const camera = VIEW_CAMERA_ARGS.section;
  try {
    // Pass 1: export the model to an intermediate mesh (geometry only).
    const meshArgs = [
      "-o",
      `/work/${SECTION_MESH_FILE}`,
      `--backend=${DEFAULT_BACKEND}`,
      RENDER_FLAG,
      `--colorscheme=${DEFAULT_COLORSCHEME}`,
      ...overrideArgs,
      `/work/${inputName}`
    ];
    await runOpenscad(meshArgs, { cwd: dir, timeoutMs });

    // Pass 2: generate the import()+difference() wrapper and render it with the section camera.
    const wrapperSource = SECTION_WRAPPER_TEMPLATE.replace(SECTION_WRAPPER_MESH_TOKEN, SECTION_MESH_FILE);
    await writeFile(join(dir, SECTION_WRAPPER_FILE), wrapperSource, "utf8");

    const renderArgs = [
      "-o",
      "/work/views/section.png",
      `--camera=${camera}`,
      ...commonFlags(imgsize),
      `/work/${SECTION_WRAPPER_FILE}`
    ];
    const { ms, stderr } = await runOpenscad(renderArgs, { cwd: dir, timeoutMs });
    const outPath = join(dir, "views/section.png");
    let bytes: number | null = null;
    try {
      bytes = (await stat(outPath)).size;
    } catch {
      bytes = null;
    }
    return {
      view: "section",
      ok: bytes !== null && bytes > 0,
      path: bytes !== null && bytes > 0 ? outPath : null,
      camera,
      projection: "ortho",
      imgsize,
      bytes,
      render_ms: ms,
      stderr: filterOpenscadDiagnostics(stderr)
    };
  } catch (err) {
    const typed = ScadForgeError.normalize(err, "RENDER_FAILED", "render_views: section view failed");
    return {
      view: "section",
      ok: false,
      path: null,
      camera,
      projection: "ortho",
      imgsize,
      bytes: null,
      render_ms: 0,
      stderr: typed.message
    };
  }
}

async function copyRenderedOut(views: RenderedView[], outDir: string): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(outDir, { recursive: true }));
  for (const view of views) {
    if (!view.ok || !view.path) continue;
    const dest = join(outDir, `${view.view}.png`);
    await copyFile(view.path, dest);
    view.path = dest; // point the returned path at the caller's outDir, not the (about-to-be-removed) temp dir
  }
}

// Re-exported for tests that want to read a rendered PNG's raw bytes without
// re-deriving the path convention.
export async function readRenderedPng(outDir: string, view: ViewName): Promise<Buffer> {
  return readFile(join(outDir, `${view}.png`));
}
