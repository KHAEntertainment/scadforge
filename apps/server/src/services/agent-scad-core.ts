// SPDX-License-Identifier: Apache-2.0
//
// The project-bound implementation of `packages/agent`'s OWN `ScadCoreApi`
// (`@scadforge/agent`'s `tools/scad-core-api.ts`) — the surface the seven tool
// handlers call. Distinct from `services/scad-core-api.ts`, which is the
// server's REST-facing seam: the agent's version is scoped to ONE project for
// the duration of ONE turn and speaks the CAD vocabulary, not the wire shapes.
//
// This is where Issue #16's open seam question lands: `artifactUrl`,
// `exportFileName` and `readImageBase64` are implemented HERE, in the server,
// over `services/urls.ts`. See that file's header for the full rationale.

import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SnapshotManifest, ToolArtifact, ViewName } from "@scadforge/protocol";
import type {
  AgentExportRequest,
  AgentRenderRequest,
  AgentValidateRequest,
  LibraryIndexApi,
  ProjectState,
  ScadCoreApi as AgentScadCoreApi,
  SetParamsOutcome,
  WriteScadOutcome,
  WriteScadRequest
} from "@scadforge/agent";
import { lookup as libraryLookup } from "@scadforge/libs";
import {
  attachValidationToSnapshot,
  createSnapshot,
  exportRun,
  exportsDir,
  mergeParamsAtomic,
  recordExport,
  rootModelPath,
  runParamExport,
  runSyntaxCheck,
  validateModel
} from "@scadforge/scad-core";
import type {
  ExportRunResult,
  LibraryName,
  LibrarySymbol,
  ParamSchema,
  ParamValues,
  RenderResult,
  ValidationReport,
  ValidationResult
} from "@scadforge/scad-core";
import type { ExportRecord } from "@scadforge/protocol";
import { renderAndAttach } from "./scad-core-impl.js";
import { planParamUpdate, readParams, readProject, readScad, stageSnapshotModel, type ServerRuntime } from "./runtime.js";
import { exportFileUrl, renderFileUrl, snapshotUrl } from "./urls.js";

/** An empty schema, used when the current model cannot be parsed for parameters yet. */
const EMPTY_PARAM_SCHEMA: ParamSchema = { title: "", parameters: [] };

/**
 * The library index seam (`packages/libs`, Issue #19).
 *
 * `lookup` is synchronous and throws `LibraryLookupError` on an empty query or
 * a missing index; the agent's seam is async and expects a rejection the tool
 * handler can type. Wrapping in an async function is all the adaptation
 * needed — the returned entries are already `LibrarySymbol` verbatim, which is
 * exactly why #19 built the index against scad-core's frozen contract.
 */
export function createLibraryIndex(): LibraryIndexApi {
  return {
    async lookup(request: { query: string; library?: LibraryName; limit?: number }): Promise<LibrarySymbol[]> {
      return libraryLookup(request.query, { library: request.library, limit: request.limit });
    }
  };
}

/** Options for {@link createAgentScadCore}. */
export interface AgentScadCoreOptions {
  runtime: ServerRuntime;
  projectId: string;
  /** Called whenever a snapshot is created, so the caller can track the head. */
  onSnapshot?: (snapshot: SnapshotManifest) => void;
}

/**
 * Binds `packages/agent`'s CAD seam to one project.
 *
 * Every method rejects with a `ScadForgeError` (the `ScadCoreFailure` shape
 * the agent expects: an `error_code` property the handler passes straight
 * through instead of flattening to `INTERNAL_ERROR`).
 */
export function createAgentScadCore(options: AgentScadCoreOptions): AgentScadCoreApi {
  const { runtime, projectId } = options;
  const dir = runtime.dirFor(projectId);

  /** The most recent validation report this turn produced, echoed back by `read_project`. */
  let lastValidation: ValidationReport | null = null;

  async function paramSchema(): Promise<ParamSchema> {
    try {
      return await runParamExport(rootModelPath(dir), { libraryPaths: runtime.libraryPaths });
    } catch {
      // A model that does not parse yet (a brand-new project's placeholder, or
      // a broken intermediate state) has no schema. That is not a tool
      // failure: `read_project` must still answer so the model can see the
      // source it needs to fix.
      return EMPTY_PARAM_SCHEMA;
    }
  }

  return {
    async readProject(): Promise<ProjectState> {
      const project = await readProject(dir);
      const [scad, params, param_schema] = await Promise.all([readScad(dir), readParams(dir), paramSchema()]);
      return { scad, params, param_schema, validation: lastValidation, head_snapshot: project.head };
    },

    async writeScad(request: WriteScadRequest): Promise<WriteScadOutcome> {
      // Snapshot FIRST, then syntax-check the file that was actually written:
      // a rejected write that is never persisted leaves the model unable to
      // read back what it just tried, and the syntax check is a full container
      // round trip that must not gate durability.
      //
      // Params are carried forward UNCHANGED (`accepted: {}`), but still go
      // through `mergeParamsAtomic` (Issue #44): reading "current params" and
      // writing them back into this snapshot must hold the SAME cross-process
      // params lock every other params writer uses, or this content-only edit
      // could still race a concurrent `set_params`/REST params update and
      // silently regress its just-committed change.
      const snapshot = await mergeParamsAtomic(dir, {}, (params) =>
        createSnapshot(dir, {
          content: request.content,
          params,
          message: request.message,
          origin: "agent",
          pass: request.pass
        })
      );
      options.onSnapshot?.(snapshot);

      const syntax_check = await runSyntaxCheck(rootModelPath(dir), { libraryPaths: runtime.libraryPaths });
      return { bytes: Buffer.byteLength(request.content, "utf8"), syntax_check, snapshot };
    },

    async setParams(params: ParamValues, pass: number): Promise<SetParamsOutcome> {
      // Single code path (Issue #32): the exact same validation the REST
      // route uses (`scad-core-impl.ts`'s `updateParams`, both via
      // `runtime.ts`'s `planParamUpdate`). The frozen `set_params` result
      // shape (`contract.ts`) has no per-value error field, so every
      // rejection — unknown name, wrong type, out of range — folds into
      // `unknown_params`; only `plan.accepted` (which already excludes them)
      // is applied, never a silent coerce of a bad value.
      const plan = await planParamUpdate(dir, runtime, params);
      const unknown_params = plan.rejected.map((r) => r.name);

      // `mergeParamsAtomic` (Issue #44) reads the CURRENT root `params.json`
      // and creates the snapshot WHILE HOLDING the cross-process params lock,
      // so this can never race a concurrent REST params update (or another
      // `set_params`/`write_scad` call) merging a DISJOINT key onto the same
      // file.
      const snapshot = await mergeParamsAtomic(dir, plan.accepted, async (merged) =>
        createSnapshot(dir, {
          content: await readScad(dir),
          params: merged,
          message: `Set ${Object.keys(params).length - unknown_params.length} parameter(s)`,
          origin: "manual",
          pass
        })
      );
      options.onSnapshot?.(snapshot);
      return { params: snapshot.params, unknown_params, snapshot };
    },

    async renderViews(request: AgentRenderRequest): Promise<RenderResult> {
      const { result } = await renderAndAttach(runtime, projectId, {
        views: request.views,
        params: request.params,
        imgsize: request.imgsize
      });
      return result;
    },

    async validateMesh(request: AgentValidateRequest): Promise<ValidationResult> {
      // Pin the target snapshot BEFORE running the (container round-trip,
      // potentially slow) validation, and validate THAT snapshot's own
      // persisted `model.scad`/`params.json` -- never `rootModelPath(dir)` /
      // "whatever is head now" (Issue #45). A `write_scad` or `set_params`
      // call that lands while this validation is still in flight moves
      // `project.head` to a NEWER snapshot; re-reading head only at the end
      // (the old code) would then attach a report describing stale content
      // onto the wrong snapshot -- exactly the observed defect (a snapshot's
      // manifest changing to a validation result that does not describe its
      // own `model.scad`).
      //
      // An explicit `params` override is a hypothetical/preview validation
      // ("what if these values?") that does NOT describe the target
      // snapshot's own persisted state, so its result is returned but never
      // written into history.
      const project = await readProject(dir);
      const targetId = project.head;
      const isPreview = request.params !== undefined;

      const staged = targetId && !isPreview ? await stageSnapshotModel(dir, targetId) : null;
      let result: ValidationResult;
      try {
        result = await validateModel(staged?.scadPath ?? rootModelPath(dir), {
          params: staged?.params ?? request.params,
          gate: { allowMultiPart: request.allowMultiPart === true },
          libraryPaths: runtime.libraryPaths
        });
      } finally {
        await staged?.cleanup();
      }
      lastValidation = result.report;

      // Persist the verdict onto the PINNED snapshot -- never a snapshot id
      // re-read after the (slow) work above, and never for a preview run with
      // overridden params (it doesn't describe any snapshot's own content).
      // Without this the report would live only in this turn's memory: the
      // History badge, the `ExportResponse.validation` field and any later
      // inspection of what a given revision actually measured would all be
      // permanently null.
      if (targetId && !isPreview) {
        // A validation run whose bookkeeping fails must not fail the tool —
        // the model still needs to see the report it just paid for.
        await attachValidationToSnapshot(dir, targetId, result).catch(() => {});
      }
      return result;
    },

    async exportModel(request: AgentExportRequest): Promise<ExportRunResult> {
      // Pin the head snapshot id BEFORE running the (slow) export, and --
      // unless the caller passed an explicit `params` override -- export THAT
      // PINNED snapshot's own staged `model.scad`/`params.json`, never
      // `rootModelPath(dir)` (Issue #45's AC5: exporting must describe the
      // snapshot it's recorded against, immune to a concurrent
      // `write_scad`/`set_params` moving head mid-export).
      const project = await readProject(dir);
      const snapshotId = project.head ?? "0000";
      const isPreview = request.params !== undefined;
      const staged = project.head && !isPreview ? await stageSnapshotModel(dir, project.head) : null;
      const outDir = exportsDir(dir);
      let result: ExportRunResult;
      try {
        result = await exportRun(
          {
            scadPath: staged?.scadPath ?? rootModelPath(dir),
            outDir,
            format: request.format,
            params: staged ? staged.params : request.params,
            allowValidationFailure: request.allowValidationFailure === true
          },
          { libraryPaths: runtime.libraryPaths }
        );
      } finally {
        await staged?.cleanup();
      }
      if (!result.ok || !result.path) return result;

      // Same stable naming and ledger entry the REST export produces, so an
      // agent-driven export and a UI-driven one are indistinguishable on disk.
      const file = `${project.id}-${snapshotId}.${result.format}`;
      const finalPath = join(outDir, file);
      await rename(result.path, finalPath);
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
      await recordExport(dir, record);
      return { ...result, path: finalPath, bytes };
    },

    // ── the three host-owned mappings (Issue #16 seam question) ──────────────

    async readImageBase64(absolutePath: string): Promise<string> {
      const data = await readFile(absolutePath);
      return data.toString("base64");
    },

    artifactUrl(kind: ToolArtifact["kind"], ref: string): string | null {
      switch (kind) {
        case "snapshot":
          return snapshotUrl(projectId, ref);
        case "render": {
          // `ref` is the PNG's absolute path inside the snapshot's rendered
          // views (`renderAndAttach` re-points it there via
          // `snapshotRenderPath`). That physically lives under
          // `.scadforge/derived/<id>/views/` (Issue #45: a render attached
          // after creation is never written into `history/<id>/views/`, so
          // that directory stays immutable) -- recognize either segment name
          // so this keeps working regardless of which tree the path is under.
          const rel = relative(dir, ref).split(/[\\/]/);
          const rootIndex = Math.max(rel.indexOf("history"), rel.indexOf("derived"));
          const view = basename(ref, ".png") as ViewName;
          if (rootIndex === -1 || rel.length <= rootIndex + 1) return null;
          return renderFileUrl(projectId, rel[rootIndex + 1], view);
        }
        case "export":
          return exportFileUrl(projectId, basename(ref));
        case "mesh":
          // Validation meshes are throwaway intermediates in a temp work dir
          // (`validateModel` removes them); there is nothing to serve.
          return null;
      }
    },

    exportFileName(absolutePath: string): string {
      const rel = relative(exportsDir(dir), absolutePath);
      return rel.startsWith("..") ? basename(absolutePath) : rel;
    }
  };
}
