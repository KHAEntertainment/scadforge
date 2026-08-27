// SPDX-License-Identifier: Apache-2.0
//
// The REAL `ScadCoreApi` — Issue #20's replacement for `not-wired.ts`.
//
// Binds the seam in `services/scad-core-api.ts` to `packages/scad-core`'s
// filesystem store (`.scadforge/`), OpenSCAD CLI runner and mesh validator.
// No route file changes: `createApp({scadCore, agent})` is still the only
// composition point (app.ts).
//
// Contract notes honoured here:
//   - every method throws `RouteError` with a frozen `ScadForgeErrorCode`,
//     EXCEPT the two file lookups, which return `null` for "does not exist";
//   - `renderViews` reports a failed render through `views[].ok`/`stderr`,
//     never a throw ("the process never crashes on a failed render");
//   - `runExport` refuses on a red gate without `allow_validation_failure`
//     (CLAUDE.md hard rule 7) — the gate itself lives in scad-core's
//     `exportRun`, so this method only maps its refusal onto
//     `VALIDATION_FAILED`.

import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import type {
  CreateProjectRequest,
  ExportRecord,
  ExportRequest,
  ExportResponse,
  ListProjectsResponse,
  ParamsResponse,
  ParamsUpdateRequest,
  ProjectResponse,
  RenderViewsRequest,
  RenderViewsResponse,
  RenderedViewResponse,
  RevertRequest,
  SnapshotDiffResponse,
  SnapshotManifest,
  SnapshotResponse,
  ViewName
} from "@scadforge/protocol";
import {
  DEFAULT_VIEWS,
  attachRendersToSnapshot,
  createSnapshot,
  exportRun,
  exportsDir,
  initProject,
  listSnapshots,
  readSnapshotManifest,
  recordExport,
  renderViews as runRenderViews,
  revertToSnapshot,
  rootModelPath,
  runParamExport,
  snapshotDir,
  snapshotRenderPath
} from "@scadforge/scad-core";
import type { ParamValues, RenderAttachment, RenderedView } from "@scadforge/scad-core";
import { RouteError } from "./errors.js";
import { allocateProjectId, listProjectIds } from "./project-paths.js";
import type { RenderFile, ScadCoreApi } from "./scad-core-api.js";
import {
  asRouteResult,
  readParams,
  readProject,
  readScad,
  writeRootParams,
  type ServerRuntime
} from "./runtime.js";
import { exportFileUrl, renderFileUrl } from "./urls.js";

/** The `.scad` a project starts from when the caller supplies none. */
const EMPTY_MODEL_SCAD = "// New ScadForge project.\n";

/** MIME types for the two kinds of file this API serves verbatim. */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".3mf": "model/3mf",
  ".stl": "model/stl",
  ".off": "application/octet-stream"
};

function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf(".");
  return (dot >= 0 ? CONTENT_TYPES[file.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

async function readFileOrNull(path: string): Promise<RenderFile | null> {
  try {
    const data = await readFile(path);
    return { data: new Uint8Array(data), contentType: contentTypeFor(path), bytes: data.byteLength };
  } catch {
    return null;
  }
}

/**
 * The `ScadCoreApi` methods that also serve the agent adapter. Kept exported
 * so `agent-scad-core.ts` reuses the exact render/attach pipeline rather than
 * a parallel copy of it.
 */
export interface RenderAndAttachResult {
  result: Awaited<ReturnType<typeof runRenderViews>>;
  /** The snapshot the PNGs were attached to; null when the project has no head yet. */
  snapshot: string | null;
}

/**
 * Renders the project's current `model.scad` and attaches the resulting PNGs
 * to its head snapshot (see scad-core's `store/renders.ts` for why attaching
 * to an existing snapshot is not a history rewrite).
 *
 * Rendering into a temp directory first and only then attaching means a
 * partial render never leaves half a view set inside the snapshot.
 */
export async function renderAndAttach(
  runtime: ServerRuntime,
  projectId: string,
  request: { views?: readonly ViewName[]; params?: Record<string, never> | RenderViewsRequest["params"]; imgsize?: readonly [number, number] }
): Promise<RenderAndAttachResult> {
  const dir = runtime.dirFor(projectId);
  const project = await readProject(dir);
  const outDir = await mkdtemp(join(tmpdir(), "scadforge-render-"));
  try {
    const result = await runRenderViews(
      {
        scadPath: rootModelPath(dir),
        outDir,
        views: request.views,
        params: request.params,
        imgsize: request.imgsize
      },
      { libraryPaths: runtime.libraryPaths }
    );

    const head = project.head;
    if (head) {
      const attachments: RenderAttachment[] = result.views
        .filter((view): view is RenderedView & { path: string } => view.ok && view.path !== null)
        .map((view) => ({
          view: view.view,
          sourcePath: view.path,
          render_ms: view.render_ms,
          width: view.imgsize[0],
          height: view.imgsize[1]
        }));
      if (attachments.length > 0) {
        await attachRendersToSnapshot(dir, head, attachments, {
          buildRenderUrl: (snapshotId, view) => renderFileUrl(projectId, snapshotId, view)
        });
        // Re-point each successful view at its durable home in the snapshot so
        // callers (the agent's `readImageBase64`) can still read it after the
        // temp directory below is removed.
        for (const view of result.views) {
          if (view.ok && view.path) view.path = snapshotRenderPath(dir, head, view.view);
        }
      }
    }
    return { result, snapshot: head };
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Builds the real `ScadCoreApi`. */
export function createScadCoreApi(runtime: ServerRuntime): ScadCoreApi {
  async function headSnapshot(dir: string, head: string | null): Promise<SnapshotManifest | null> {
    if (!head) return null;
    try {
      return await readSnapshotManifest(dir, head);
    } catch {
      return null;
    }
  }

  async function projectResponse(projectId: string): Promise<ProjectResponse> {
    const dir = runtime.dirFor(projectId);
    const project = await readProject(dir);
    const [scad, params, head] = await Promise.all([
      readScad(dir),
      readParams(dir),
      headSnapshot(dir, project.head)
    ]);
    return { project, scad, params, head };
  }

  async function paramsResponse(projectId: string): Promise<ParamsResponse> {
    const dir = runtime.dirFor(projectId);
    await readProject(dir);
    const [schema, values] = await Promise.all([
      asRouteResult(
        () => runParamExport(rootModelPath(dir), { libraryPaths: runtime.libraryPaths }),
        "failed to read the Customizer parameter schema"
      ),
      readParams(dir)
    ]);
    return { title: schema.title, parameters: schema.parameters as ParamsResponse["parameters"], values };
  }

  return {
    // ── projects ─────────────────────────────────────────────────────────────

    async createProject(input: CreateProjectRequest): Promise<ProjectResponse> {
      const projectId = await asRouteResult(
        () => allocateProjectId(runtime.root, input.name),
        "failed to allocate a project id"
      );
      const dir = runtime.dirFor(projectId);
      await asRouteResult(async () => {
        await mkdir(dir, { recursive: true });
        await initProject(dir, {
          id: projectId,
          name: input.name,
          provider: runtime.provider,
          content: input.scad ?? EMPTY_MODEL_SCAD,
          params: {},
          message: "Initial snapshot"
        });
      }, "failed to create project");
      return projectResponse(projectId);
    },

    getProject: (projectId) => projectResponse(projectId),

    async listProjects(): Promise<ListProjectsResponse> {
      const ids = await asRouteResult(() => listProjectIds(runtime.root), "failed to list projects");
      const projects = [];
      for (const id of ids) {
        try {
          projects.push(await readProject(runtime.dirFor(id)));
        } catch {
          // A directory without a readable `.scadforge/project.json` is not a
          // project (a stray folder, a half-written create). Skip it rather
          // than failing the whole listing.
        }
      }
      return { projects };
    },

    // ── snapshots ────────────────────────────────────────────────────────────

    async listSnapshots(projectId): Promise<SnapshotManifest[]> {
      const dir = runtime.dirFor(projectId);
      await readProject(dir); // PROJECT_NOT_FOUND before SNAPSHOT_NOT_FOUND
      const snapshots = await asRouteResult(() => listSnapshots(dir), "failed to list snapshots");
      // `api.ts` promises newest first; the store lists oldest first.
      return snapshots.reverse();
    },

    async getSnapshot(projectId, snapshotId): Promise<SnapshotResponse> {
      const dir = runtime.dirFor(projectId);
      await readProject(dir);
      const snapshot = await asRouteResult(
        () => readSnapshotManifest(dir, snapshotId),
        `failed to read snapshot '${snapshotId}'`
      );
      const scad = await asRouteResult(
        () => readFile(join(snapshotDir(dir, snapshotId), snapshot.files.model_scad), "utf8"),
        `failed to read snapshot '${snapshotId}' model.scad`
      );
      return { snapshot, scad };
    },

    async getSnapshotDiff(projectId, snapshotId): Promise<SnapshotDiffResponse> {
      const dir = runtime.dirFor(projectId);
      await readProject(dir);
      const snapshot = await asRouteResult(
        () => readSnapshotManifest(dir, snapshotId),
        `failed to read snapshot '${snapshotId}'`
      );
      // `diff_patch` is null for the first snapshot; the frozen response shape
      // says "empty string for the first snapshot", not null.
      const diff = snapshot.files.diff_patch
        ? await readFile(join(snapshotDir(dir, snapshotId), snapshot.files.diff_patch), "utf8").catch(() => "")
        : "";
      return { id: snapshot.id, parent: snapshot.parent, diff };
    },

    async revertSnapshot(projectId, snapshotId, _request: RevertRequest): Promise<SnapshotResponse> {
      const dir = runtime.dirFor(projectId);
      await readProject(dir);
      const snapshot = await asRouteResult(
        () => revertToSnapshot(dir, snapshotId),
        `failed to revert to snapshot '${snapshotId}'`
      );
      const scad = await readFile(join(snapshotDir(dir, snapshot.id), snapshot.files.model_scad), "utf8");
      return { snapshot, scad };
    },

    async getSnapshotRenderFile(projectId, snapshotId, view): Promise<RenderFile | null> {
      const dir = runtime.dirFor(projectId);
      return readFileOrNull(snapshotRenderPath(dir, snapshotId, view as ViewName));
    },

    // ── params ───────────────────────────────────────────────────────────────

    getParams: (projectId) => paramsResponse(projectId),

    async updateParams(projectId, request: ParamsUpdateRequest): Promise<ParamsResponse> {
      const dir = runtime.dirFor(projectId);
      await readProject(dir);
      const current = await readParams(dir);
      // Partial update: only the named parameters change (`api.ts`).
      const merged: ParamValues = { ...current, ...request.values };
      const message = `Set ${Object.keys(request.values).length} parameter(s)`;

      if (request.snapshot !== false) {
        // The snapshot carries the CURRENT source unchanged — a parameter
        // write is not a model edit, and passing anything else here would
        // silently truncate `model.scad`.
        const content = await readScad(dir);
        await asRouteResult(
          () => createSnapshot(dir, { content, params: merged, message, origin: "manual", pass: null }),
          "failed to snapshot the parameter update"
        );
      } else {
        await asRouteResult(() => writeRootParams(dir, merged), "failed to persist parameters");
      }
      return paramsResponse(projectId);
    },

    // ── renders ──────────────────────────────────────────────────────────────

    async renderViews(projectId, request: RenderViewsRequest): Promise<RenderViewsResponse> {
      const requested = request.views ?? DEFAULT_VIEWS;
      const { result, snapshot } = await renderAndAttach(runtime, projectId, {
        views: request.views,
        params: request.params,
        imgsize: request.imgsize
      });
      const views: RenderedViewResponse[] = result.views.map((view) => ({
        view: view.view,
        ok: view.ok,
        url: view.ok && snapshot ? renderFileUrl(projectId, snapshot, view.view) : null,
        width: view.imgsize[0],
        height: view.imgsize[1],
        bytes: view.bytes,
        render_ms: view.render_ms,
        stderr: view.stderr
      }));
      return {
        ok: result.ok && views.length === requested.length,
        views,
        total_ms: result.total_ms,
        snapshot
      };
    },

    // ── export ───────────────────────────────────────────────────────────────

    async runExport(projectId, request: ExportRequest): Promise<ExportResponse> {
      const dir = runtime.dirFor(projectId);
      const project = await readProject(dir);
      const outDir = exportsDir(dir);

      const result = await asRouteResult(
        () =>
          exportRun(
            {
              scadPath: rootModelPath(dir),
              outDir,
              format: request.format,
              params: request.params,
              allowValidationFailure: request.allow_validation_failure === true
            },
            { libraryPaths: runtime.libraryPaths }
          ),
        "export failed"
      );

      if (!result.ok || !result.path) {
        throw new RouteError(
          result.error_code ?? "EXPORT_FAILED",
          result.message ?? "The export could not be produced."
        );
      }

      // scad-core writes `out.<format>`; give the artifact a stable, unique
      // name so successive exports of the same project do not overwrite one
      // another and `ExportRecord.file` matches the frozen example shape.
      const snapshotId = project.head ?? "0000";
      const file = `${project.id}-${snapshotId}.${result.format}`;
      const finalPath = join(outDir, file);
      await asRouteResult(() => rename(result.path as string, finalPath), "failed to name the export artifact");
      const bytes = (await stat(finalPath)).size;

      const record: ExportRecord = {
        snapshot: snapshotId,
        format: result.format,
        file,
        url: exportFileUrl(projectId, file),
        bytes,
        timestamp: new Date().toISOString(),
        validation_overridden: result.validation_overridden
      };
      await asRouteResult(() => recordExport(dir, record), "failed to record the export");

      const head = await headSnapshot(dir, project.head);
      return { export: record, validation: head?.validation ?? null };
    },

    async getExportFile(projectId, file): Promise<RenderFile | null> {
      const dir = runtime.dirFor(projectId);
      // `PROJECT_LAYOUT.exportsDir` is the only directory this may reach; the
      // route has already rejected any `file` that is not a bare path segment.
      if (file === PROJECT_LAYOUT.snapshot.manifestFile) return null;
      return readFileOrNull(join(exportsDir(dir), file));
    }
  };
}
