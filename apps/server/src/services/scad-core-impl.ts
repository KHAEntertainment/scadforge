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

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import type {
  BuildRequest,
  BuildResponse,
  CreateProjectRequest,
  EditorCommitRequest,
  EditorDocument,
  EditorFeature,
  EditorOperationResponse,
  EditorProofResponse,
  EditorReceipt,
  EditorSidecarStatus,
  ExportRecord,
  ExportRequest,
  ExportResponse,
  ListProjectsResponse,
  ParamsResponse,
  ParamsUpdateRequest,
  ProjectManifest,
  ProjectResponse,
  RenderViewsRequest,
  RenderViewsResponse,
  RenderedViewResponse,
  RevertRequest,
  SnapshotDiffResponse,
  SnapshotId,
  SnapshotManifest,
  SnapshotOrigin,
  SnapshotResponse,
  SourcePreflightRequest,
  SourcePreflightResponse,
  SourceResponse,
  SourceUpdateRequest,
  ViewName
} from "@scadforge/protocol";
import {
  ABORTED_REPLAY_MESSAGE,
  DEFAULT_VIEWS,
  ScadForgeError,
  analyzeSourceParams,
  applyEditorCommand,
  applyEditorTraversal,
  attachRendersToSnapshotLocked,
  attachValidationToSnapshotLocked,
  commandDigest,
  computeSourceRevision,
  createSnapshotLocked,
  editorEligibility,
  editorRevision,
  exportRunWithValidation,
  exportsDir,
  faultPoint,
  initProject,
  listSnapshots,
  lookupClaimLocked,
  lookupProofLocked,
  mergeParamsAtomic,
  normalizeLineEndings,
  persistProofRecord,
  readProjectManifestLocked,
  readSidecarLocked,
  readSnapshotManifest,
  readSnapshotManifestLocked,
  recordClaimRejectedLocked,
  recordExport,
  renderViews as runRenderViews,
  requestDigest,
  reserveClaimLocked,
  resolveSnapshotMeshPath,
  resolveSnapshotRenderPath,
  revertToSnapshot,
  rootModelPath,
  runParamExport,
  runProbe,
  runSyntaxCheck,
  snapshotDir,
  snapshotMeshPath,
  snapshotRenderPath,
  sourceFingerprint,
  updateRootParamsLocked,
  validateModel,
  withRecoveredProject
} from "@scadforge/scad-core";
import type { ClaimLookupResult, LockedProject, ParamSchema, ParamValues, RenderAttachment, RenderedView } from "@scadforge/scad-core";
import { RouteError } from "./errors.js";
import { allocateProjectId, listProjectIds } from "./project-paths.js";
import type { RenderFile, ScadCoreApi } from "./scad-core-api.js";
import {
  asRouteResult,
  planParamUpdate,
  readParams,
  readParamsLocked,
  readProject,
  readScadLocked,
  stageSnapshotModel,
  type ServerRuntime
} from "./runtime.js";
import { exportFileUrl, renderFileUrl } from "./urls.js";

/** The `.scad` a project starts from when the caller supplies none. */
const EMPTY_MODEL_SCAD = "// New ScadForge project.\n";

/** Every editor-command commit's snapshot origin (S3-B ticket B6, Issue #98; `SnapshotOrigin` contract fix PR #105). */
const EDITOR_SNAPSHOT_ORIGIN: SnapshotOrigin = "editor";

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
 * Renders a project's model and, when the render describes the CURRENT head
 * snapshot's own persisted content, attaches the resulting PNGs to it (see
 * `packages/scad-core/src/store/attachments.ts` for why attaching derived
 * renders is not a history rewrite -- they land in a sibling `derived/` tree,
 * never inside `history/<id>/`).
 *
 * Issue #45: the head snapshot id is pinned BEFORE rendering, and — unless
 * the caller supplied an explicit `params` override (a hypothetical preview
 * that does not describe any snapshot's own persisted params) — the render
 * runs against THAT PINNED snapshot's own staged `model.scad`/`params.json`,
 * never `rootModelPath(dir)` ("whatever the project's current root state
 * is"). This is immune to a concurrent `write_scad`/`set_params` moving head
 * to a newer snapshot mid-render, and to `params.json` having been updated
 * without a snapshot (`PUT .../params` with `snapshot:false`). A preview
 * render (explicit `params`) is still returned to the caller, but is never
 * attached to history and its result reports `snapshot: null`.
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
  const head = project.head;
  const isPreview = request.params !== undefined;

  const outDir = await mkdtemp(join(tmpdir(), "scadforge-render-"));
  const staged = head && !isPreview ? await stageSnapshotModel(dir, head) : null;
  try {
    const result = await runRenderViews(
      {
        scadPath: staged?.scadPath ?? rootModelPath(dir),
        outDir,
        views: request.views,
        params: staged ? staged.params : request.params,
        imgsize: request.imgsize
      },
      { libraryPaths: runtime.libraryPaths }
    );

    if (head && !isPreview) {
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
        // A SECOND, sequential (never nested) boundary entry -- the pin
        // above (via `readProject`) already opened and closed its own; the
        // (slow) render ran entirely outside any lock (Issue #73: "pin
        // immutable input... release lock for engine work... recheck before
        // mutable attachment"). Attaching to `head`, the id pinned before
        // rendering, is valid regardless of whether the project's head has
        // since moved on -- this render describes THAT snapshot's own
        // content, not "whatever is current now".
        await withRecoveredProject(dir, (ctx) =>
          attachRendersToSnapshotLocked(ctx, head, attachments, {
            buildRenderUrl: (snapshotId, view) => renderFileUrl(projectId, snapshotId, view)
          })
        );
        // Re-point each successful view at its durable home in the snapshot so
        // callers (the agent's `readImageBase64`) can still read it after the
        // temp directory below is removed.
        for (const view of result.views) {
          if (view.ok && view.path) view.path = snapshotRenderPath(dir, head, view.view);
        }
      }
    }
    return { result, snapshot: isPreview ? null : head };
  } finally {
    await staged?.cleanup();
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── source revision + proposed-source compilation (Issue #54) ──────────────

/**
 * The coherent head+source+params state of a project, plus its opaque
 * revision. Also carries the S3-B B3 (Issue #87) editor sidecar's status,
 * features, digest and the resulting editor revision — an INTERNAL-ONLY
 * extension: this is the seam B5/B6/B7 read from, but no wire response
 * (`SourceResponse` etc.) exposes these fields yet. `sidecarDigest` and
 * `editorRevision` are `null` whenever the sidecar status is `missing`,
 * `corrupt` or `unsupported-version` (Tech Lead correction C1) — a caller
 * must never compute an editor revision from a sidecar that does not
 * actually, trustworthily exist on disk. `sidecarFeatures` is `[]` in that
 * case (never a fabricated non-empty list).
 */
export interface SourceState {
  project: ProjectManifest;
  head: SnapshotId | null;
  scad: string;
  params: ParamValues;
  revision: string;
  sidecarStatus: EditorSidecarStatus;
  sidecarFeatures: EditorFeature[];
  sidecarDigest: string | null;
  editorRevision: string | null;
}

/**
 * Reads the project's coherent head + `model.scad` + `params.json` (+, since
 * Issue #87, editor sidecar) state under the recovery boundary, so the
 * returned revision never mixes a head from one write with a source/params
 * from another. Every writer of those files serializes on the same lock, so
 * reading inside it is what makes the (head, source, params, sidecar) tuple
 * coherent. A missing project surfaces `PROJECT_NOT_FOUND` from the boundary
 * itself (Issue #73: `withRecoveredProject` translates the lock's own
 * missing-`.scadforge/` case), so the separate unlocked pre-check the old
 * code needed before it dared enter the lock is gone.
 *
 * Exported (was private) so this internal coherent-read result is directly
 * unit-testable — no wire-shape change; every existing wire-facing caller
 * (`sourceResponse`/`preflightSource`/`updateSource`) still destructures only
 * the fields it already used.
 */
export async function coherentSourceState(dir: string): Promise<SourceState> {
  return withRecoveredProject(dir, (ctx) => coherentSourceStateLocked(ctx));
}

/**
 * `ctx`-taking sibling of {@link coherentSourceState}, for a caller (S3-B
 * ticket B6's `submitEditorCommand`) that already holds the boundary and
 * must read this SAME coherent tuple without reacquiring the lock (Issue
 * #73's non-reentrancy guard would throw immediately on a nested
 * `withRecoveredProject` call).
 */
async function coherentSourceStateLocked(ctx: LockedProject): Promise<SourceState> {
  const project = await readProjectManifestLocked(ctx);
  const scad = await readScadLocked(ctx);
  const params = await readParamsLocked(ctx);
  const sidecarRead = await readSidecarLocked(ctx);
  const revision = computeSourceRevision(project.head, scad, params);
  return {
    project,
    head: project.head,
    scad,
    params,
    revision,
    sidecarStatus: sidecarRead.status,
    sidecarFeatures: sidecarRead.sidecar?.features ?? [],
    sidecarDigest: sidecarRead.digest,
    editorRevision: sidecarRead.digest !== null ? editorRevision(revision, sidecarRead.digest) : null
  };
}

/** Stages a raw source string into a throwaway `.scad` file for OpenSCAD to read. */
async function stageScadString(scad: string): Promise<{ scadPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "scadforge-source-"));
  const scadPath = join(dir, "model.scad");
  await writeFile(scadPath, scad, "utf8");
  return { scadPath, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

/** Result of compiling a proposed source outside the params lock. */
export interface ProposedSourceCompile {
  syntax_ok: boolean;
  diagnostics: string | null;
  schema: ParamSchema;
}

/** Injectable runner seams keep the source compiler deterministic in unit tests. */
export interface SourceCompileDeps {
  syntaxCheck?: typeof runSyntaxCheck;
  paramExport?: typeof runParamExport;
}

/**
 * Syntax-checks the proposed source and (when it parses) exports its
 * Customizer schema. Deliberately runs OUTSIDE the params lock — both steps
 * are OpenSCAD subprocess calls — the caller re-checks the revision inside the
 * lock afterwards (compile outside, recheck inside).
 */
export async function compileProposedSource(
  runtime: ServerRuntime,
  scad: string,
  deps: SourceCompileDeps = {}
): Promise<ProposedSourceCompile> {
  const staged = await stageScadString(scad);
  try {
    const syntax = await (deps.syntaxCheck ?? runSyntaxCheck)(staged.scadPath, { libraryPaths: runtime.libraryPaths });
    let schema: ParamSchema = { title: "", parameters: [] };
    if (syntax.ok) {
      // A successful syntax check does not make a failed Customizer export a
      // valid empty schema. Propagate the exporter error so preflight/save can
      // report the failure instead of silently dropping every override.
      schema = await (deps.paramExport ?? runParamExport)(staged.scadPath, { libraryPaths: runtime.libraryPaths });
    }
    return {
      syntax_ok: syntax.ok,
      diagnostics: syntax.ok ? null : syntax.errors.join("\n"),
      schema
    };
  } finally {
    await staged.cleanup();
  }
}

/**
 * Build requires a complete render set. A partial result is useful for the
 * non-mutating render preview endpoint, but must never be attached and
 * returned as a successful authoritative build.
 */
export function assertCompleteBuildRender(
  result: Awaited<ReturnType<typeof runRenderViews>>,
  expectedViews: readonly ViewName[] = DEFAULT_VIEWS
): void {
  const failed = result.views.filter((view) => !view.ok).map((view) => view.view);
  if (result.ok && result.views.length === expectedViews.length && failed.length === 0) return;

  const detail = failed.length > 0 ? ` Failed views: ${failed.join(", ")}.` : "";
  throw new RouteError("RENDER_FAILED", result.message ?? `Build render incomplete.${detail}`);
}

/** Builds the real `ScadCoreApi`. */
export function createScadCoreApi(runtime: ServerRuntime): ScadCoreApi {
  /**
   * Reads the head snapshot's manifest. Issue #73 AC7: a `head` that IS set
   * always names a snapshot that was committed (a project's `head` only ever
   * advances after that snapshot's `manifest.json` is written -- see
   * `store.ts`'s `writeSnapshotFiles`), so a read failure here is never
   * ordinary "no head yet" and must never be reported as one; it fails the
   * whole request instead (corrupt bytes -> `INTERNAL_ERROR`; a genuinely
   * missing directory despite a set head -> `SNAPSHOT_NOT_FOUND`, itself
   * exactly this kind of integrity violation).
   */
  async function headSnapshotLocked(ctx: LockedProject, head: string | null): Promise<SnapshotManifest | null> {
    if (!head) return null;
    return readSnapshotManifestLocked(ctx, head);
  }

  /** Standalone (own boundary entry) sibling of {@link headSnapshotLocked}, for a caller not already composing it with other locked reads under one `ctx`. */
  async function headSnapshot(dir: string, head: string | null): Promise<SnapshotManifest | null> {
    if (!head) return null;
    return asRouteResult(
      () => withRecoveredProject(dir, (ctx) => headSnapshotLocked(ctx, head)),
      `failed to read head snapshot '${head}'`
    );
  }

  async function projectResponse(projectId: string): Promise<ProjectResponse> {
    const dir = runtime.dirFor(projectId);
    // ONE boundary entry for project + scad + params + head together (Issue
    // #73 AC9): the old code read these as FOUR separate operations (an
    // unlocked `readProject` pre-check, then three more independently-timed
    // reads), so a concurrent writer landing between them could hand back a
    // head that no longer agrees with the scad/params it's paired with.
    return asRouteResult(() => withRecoveredProject(dir, async (ctx) => {
      const project = await readProjectManifestLocked(ctx);
      const [scad, params, head] = await Promise.all([
        readScadLocked(ctx),
        readParamsLocked(ctx),
        headSnapshotLocked(ctx, project.head)
      ]);
      return { project, scad, params, head };
    }), "failed to read project");
  }

  async function paramsResponse(projectId: string): Promise<ParamsResponse> {
    const dir = runtime.dirFor(projectId);
    // The schema is a LIVE, derived view of the current `model.scad` via an
    // OpenSCAD subprocess call -- deliberately kept outside any lock (never
    // slow work under the lock). `values` still goes through its own
    // boundary entry (`readParams`); the two are not required to describe
    // the exact same instant here (unlike `projectResponse`/
    // `coherentSourceState`, this response carries no revision a caller
    // could then act on as if it were pinned).
    const [schema, values] = await Promise.all([
      asRouteResult(
        () => runParamExport(rootModelPath(dir), { libraryPaths: runtime.libraryPaths }),
        "failed to read the Customizer parameter schema"
      ),
      readParams(dir)
    ]);
    return { title: schema.title, parameters: schema.parameters as ParamsResponse["parameters"], values };
  }

  async function sourceResponse(projectId: string): Promise<SourceResponse> {
    const dir = runtime.dirFor(projectId);
    const state = await asRouteResult(() => coherentSourceState(dir), "failed to read source");
    // A second, sequential (not nested) boundary entry -- coherentSourceState's
    // own entry has already closed by the time this runs.
    const head = state.head ? await headSnapshot(dir, state.head) : null;
    return { project: state.project, scad: state.scad, params: state.params, head, revision: state.revision };
  }

  // ── editor (S3-B B6, Issue #98) ───────────────────────────────────────────

  /**
   * `GET .../editor`'s coherent document read. Pins the source/params/sidecar
   * tuple under ONE boundary entry (`coherentSourceState`), then compiles the
   * pinned source and computes eligibility entirely OUTSIDE it -- same split
   * `compileProposedSource` already documents on itself, and the same
   * failure mode `verifyEditorCommand` uses for an unparseable committed
   * source (`RENDER_FAILED`, never a partial/fabricated document).
   *
   * Story seam ("Source fingerprint and unreadable-sidecar revision"): for a
   * `corrupt`/`missing`/`unsupported-version` sidecar, `coherentSourceState`
   * already reports `sidecarFeatures: []` and `editorRevision: null` -- this
   * substitutes `sourceRevision` for the document's `editorRevision` in
   * exactly that case, per the story's explicit rule ("editorRevision equals
   * sourceRevision for those three statuses"). `legacy-empty` is read-only
   * here, same as every other status -- nothing mutates on a GET.
   */
  async function editorDocumentResponse(projectId: string): Promise<EditorDocument> {
    const dir = runtime.dirFor(projectId);
    const state = await asRouteResult(() => coherentSourceState(dir), "failed to read the editor document");
    const compiled = await asRouteResult(
      () => compileProposedSource(runtime, state.scad),
      "failed to read the parameter schema"
    );
    if (!compiled.syntax_ok) {
      throw new RouteError("RENDER_FAILED", "The project's committed source failed to syntax-check.");
    }
    return {
      version: 1,
      projectId,
      head: state.head,
      sourceRevision: state.revision,
      sourceFingerprint: sourceFingerprint(state.scad),
      editorRevision: state.editorRevision ?? state.revision,
      scad: state.scad,
      parameters: compiled.schema.parameters as EditorDocument["parameters"],
      values: state.params,
      sidecar: { version: 1, features: state.sidecarFeatures },
      sidecarStatus: state.sidecarStatus,
      eligibility: editorEligibility(state.sidecarFeatures, compiled.schema)
    };
  }

  /** Maps B4's internal `ClaimLookupResult` onto the frozen `EditorOperationResponse` wire shape -- `accepted` is deliberately never forwarded (internal-only, not part of the wire). */
  function toEditorOperationResponse(looked: ClaimLookupResult): EditorOperationResponse {
    if (looked.kind === "committed") {
      return { version: 1, state: "committed", receipt: looked.receipt };
    }
    if (looked.kind === "definitely_not_committed") {
      return {
        version: 1,
        state: "definitely_not_committed",
        requestDigest: looked.requestDigest,
        reason: looked.reason,
        error: looked.error
      };
    }
    return { version: 1, state: "unknown", requestDigest: looked.requestDigest };
  }

  /**
   * `POST .../editor/commands` — the idempotent command handler (S3-B ticket
   * B6). Runs the ticket's ordered steps 2–7 inside ONE boundary entry
   * (step 1, parse + `requestDigest`, already happened in the route before
   * this is ever called — parsing needs no lock). No engine work happens
   * anywhere in this function: the proof this trusts was already rendered
   * by an earlier `verifyEditorCommand` call, entirely outside any lock — see
   * `commands.ts`'s module header for exactly which spec checks rest on that
   * proof versus which are always re-run here.
   */
  async function submitEditorCommand(projectId: string, request: EditorCommitRequest): Promise<EditorReceipt> {
    const dir = runtime.dirFor(projectId);
    const digest = requestDigest({ ...request, projectId });

    return asRouteResult(
      () =>
        withRecoveredProject(dir, async (ctx) => {
          // Steps 2+3: claim lookup and reserve, as one durable operation --
          // "malformed requests that cannot be canonicalized reserve
          // nothing" is already satisfied by the route's own parse step
          // running before this is ever called.
          const reserved = await reserveClaimLocked(ctx, request.operationId, digest, request);

          // NOTE: every throw inside this callback MUST be a `ScadForgeError`
          // (scad-core's own typed error), never `apps/server`'s `RouteError`.
          // `withRecoveredProject` wraps this whole callback in scad-core's
          // own `withTypedError`, which only preserves the code of an error
          // that is ALREADY a `ScadForgeError` (`ScadForgeError.normalize`);
          // anything else -- including a `RouteError`, a class scad-core has
          // never heard of -- gets flattened to a generic `INTERNAL_ERROR`
          // ("failed to acquire the recovery boundary for '<dir>': <message>"),
          // silently losing the intended CONFLICT/VALIDATION_FAILED code. The
          // outer `asRouteResult`/`toRouteError` (runtime.ts) converts a
          // `ScadForgeError` back into the equivalent `RouteError` once it
          // propagates past this boundary, so the wire-visible status is
          // unaffected -- only the class thrown FROM INSIDE the lock matters.
          if (reserved.kind === "conflict") {
            throw new ScadForgeError("CONFLICT", "A different request already used this operation id; refresh and submit a new operation.");
          }
          if (reserved.kind === "same-request") {
            const terminal = reserved.terminal;
            if (terminal === null) {
              // Still pending. `recover(ctx)` (which just ran, above this
              // callback) resolves every genuinely orphaned pending claim to
              // `aborted` before any caller's own work -- claim-plus-commit
              // work only ever runs under this SAME exclusive lock, so a
              // claim still pending here cannot belong to a caller genuinely
              // in flight (it would still hold the lock). Unreachable in
              // practice; kept as a typed response rather than an assertion.
              throw new ScadForgeError("CONFLICT", "This operation is still being processed; check its status and retry.");
            }
            if (terminal.kind === "committed") {
              return terminal.receipt; // idempotent replay: identical receipt.
            }
            if (terminal.kind === "rejected") {
              throw new ScadForgeError(terminal.error.error_code, terminal.error.message); // original status, verbatim.
            }
            throw new ScadForgeError("CONFLICT", ABORTED_REPLAY_MESSAGE); // aborted
          }

          // reserved.kind === "reserved" -- a genuinely fresh claim. Fires the
          // "after-claim" fault point the instant this reservation is durable
          // (Issue #111): the real editor-command path, not B4's dead
          // `commitWithClaimLocked` driver. Never fires on a same-request
          // replay or a conflict (both already returned/threw above) and
          // always before any proof lookup or staging below -- inert unless
          // `SCADFORGE_FAULT_POINT=after-claim` is set.
          await faultPoint("after-claim");

          // Returns (never throws) the error to construct -- an explicit
          // `throw` at each call site is what TypeScript's control-flow
          // analysis reliably narrows on; a `never`-returning helper thrown
          // FROM INSIDE itself does not narrow a caller's later reads the
          // same way when only awaited, not thrown, at the call site.
          const rejectionError = async (code: "VALIDATION_FAILED" | "CONFLICT", message: string): Promise<ScadForgeError> => {
            await recordClaimRejectedLocked(ctx, request.operationId, { error_code: code, message });
            return new ScadForgeError(code, message);
          };

          const state = await coherentSourceStateLocked(ctx);

          // Step 4a: sidecar status must support editor commands at all,
          // whatever revision the client sent (story seam: "B6 must refuse
          // every command when the status is not ready or legacy-empty").
          if (state.sidecarStatus !== "ready" && state.sidecarStatus !== "legacy-empty") {
            throw await rejectionError("CONFLICT", `Editor commands are unsupported while the sidecar status is "${state.sidecarStatus}".`);
          }
          // Step 4b: authority.
          if (state.editorRevision !== request.baseEditorRevision) {
            throw await rejectionError("CONFLICT", "The base editor revision is stale; refresh and retry.");
          }

          // Step 4c: proof. `lookupProofLocked` already re-checks TTL and the
          // proof record's OWN internal digest consistency; this ADDITIONALLY
          // checks that the SUBMITTED request is what that proof actually
          // covers (a digest match here is a preimage guarantee that
          // request.command/intent/traversal/baseEditorRevision are exactly
          // what was proven).
          const proofLookup = await lookupProofLocked(ctx, request.proofId);
          if (proofLookup.status === "not-found" || proofLookup.status === "digest-mismatch") {
            throw await rejectionError("VALIDATION_FAILED", "The proof for this command is missing or does not match; re-verify and retry.");
          }
          if (proofLookup.status === "expired") {
            throw await rejectionError("CONFLICT", "The proof for this command has expired; re-verify and retry.");
          }
          // proofLookup.status === "valid"
          const proof = proofLookup.proof;
          const submittedCommandDigest = commandDigest({
            version: 1,
            projectId,
            baseEditorRevision: request.baseEditorRevision,
            command: request.command,
            intent: request.intent,
            traversal: request.traversal
          });
          if (submittedCommandDigest !== proof.commandDigest) {
            throw await rejectionError("VALIDATION_FAILED", "The proof for this command does not match the submitted command.");
          }

          // Steps 5/6: apply the command (edit/setup) or its traversal
          // (undo/redo) -- pure, no I/O (packages/scad-core/src/editor/commands.ts).
          const applied =
            request.intent === "undo" || request.intent === "redo"
              ? await (async () => {
                  const traversal = request.traversal!; // parser guarantees non-null for undo/redo
                  const originalLookup = await lookupClaimLocked(ctx, traversal.operationId);
                  const originalAccepted = originalLookup.kind === "committed" ? (originalLookup.accepted ?? null) : null;
                  return applyEditorTraversal({
                    intent: request.intent,
                    traversal,
                    submittedCommand: request.command,
                    currentFeatures: state.sidecarFeatures,
                    currentParams: state.params,
                    originalAccepted
                  });
                })()
              : applyEditorCommand({
                  projectId,
                  baseEditorRevision: request.baseEditorRevision,
                  sourceFingerprint: sourceFingerprint(state.scad),
                  command: request.command,
                  currentFeatures: state.sidecarFeatures,
                  currentParams: state.params,
                  provenCandidateParams: proof.candidateParams
                });

          if (applied.status === "refused") {
            throw await rejectionError(applied.code, applied.message);
          }

          // Step 7: stage, decide and publish through B4, in ONE transaction
          // with the new sidecar, params, snapshot (origin "editor") and
          // receipt.
          let receipt: EditorReceipt | undefined;
          await createSnapshotLocked(
            ctx,
            {
              content: state.scad,
              params: applied.nextParams,
              message: applied.message,
              origin: EDITOR_SNAPSHOT_ORIGIN,
              pass: null
            },
            {
              sidecar: { version: 1, features: applied.nextFeatures },
              markerFlip: state.sidecarStatus === "legacy-empty",
              editor: {
                claim: { operationId: request.operationId },
                accepted: applied.accepted ?? undefined,
                buildReceipt: (facts) => {
                  receipt = {
                    version: 1,
                    projectId,
                    operationId: request.operationId,
                    requestDigest: digest,
                    baseEditorRevision: request.baseEditorRevision,
                    editorRevision: facts.editorRevision,
                    snapshotId: facts.snapshotId,
                    values: applied.nextParams,
                    sidecarDigest: facts.sidecarDigest
                  };
                  return receipt;
                }
              }
            }
          );
          return receipt!;
        }),
      "failed to process the editor command"
    );
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
        () =>
          revertToSnapshot(dir, snapshotId, {
            buildRenderUrl: (newSnapshotId, view) => renderFileUrl(projectId, newSnapshotId, view)
          }),
        `failed to revert to snapshot '${snapshotId}'`
      );
      const scad = await readFile(join(snapshotDir(dir, snapshot.id), snapshot.files.model_scad), "utf8");
      return { snapshot, scad };
    },

    async getSnapshotRenderFile(projectId, snapshotId, view): Promise<RenderFile | null> {
      const dir = runtime.dirFor(projectId);
      // Read-time fallback (Issue #45 follow-up): a project that predates
      // this fix has its renders physically in `history/<id>/views/`, not
      // `derived/<id>/`. `resolveSnapshotRenderPath` checks derived first,
      // then falls back to history -- read-only, never migrates the legacy
      // file, so it never touches `history/`.
      const path = await resolveSnapshotRenderPath(dir, snapshotId, view as ViewName);
      if (!path) return null;
      return readFileOrNull(path);
    },

    async getSnapshotMeshFile(projectId, snapshotId): Promise<RenderFile | null> {
      const dir = runtime.dirFor(projectId);
      // Read-time fallback (Issue #45/#41 reconciliation): a snapshot
      // validated between #50's merge and this reconciliation landing has
      // its mesh physically at `history/<id>/mesh.stl`, not
      // `derived/<id>/`. `resolveSnapshotMeshPath` checks derived first, then
      // falls back to history -- read-only, never migrates the legacy file.
      // A genuinely missing mesh is `null` either way, never a throw; the
      // route turns that into a 404 the viewer renders as "no mesh for this
      // snapshot yet".
      const path = await resolveSnapshotMeshPath(dir, snapshotId);
      if (!path) return null;
      return readFileOrNull(path);
    },

    // ── params ───────────────────────────────────────────────────────────────

    getParams: (projectId) => paramsResponse(projectId),

    async updateParams(projectId, request: ParamsUpdateRequest): Promise<ParamsResponse> {
      const dir = runtime.dirFor(projectId);
      await readProject(dir);
      // Single code path (Issue #32): the same validation `set_params` uses
      // (`runtime.ts`'s `planParamUpdate`). An unknown name, an out-of-range
      // value, or a value of the wrong type is a hard failure here — never a
      // silent coerce, never a silent drop (unlike the agent tool, whose
      // frozen result shape can only report rejections via `unknown_params`,
      // this REST route's frozen `ApiError` shape can say exactly what was
      // wrong with each one). Validation depends only on `request.values` and
      // the schema, so it can happen before the params lock is even acquired.
      const plan = await planParamUpdate(dir, runtime, request.values);
      if (plan.rejected.length > 0) {
        throw new RouteError(
          "VALIDATION_FAILED",
          plan.rejected.map((r) => r.message).join(" ")
        );
      }
      const message = `Set ${Object.keys(request.values).length} parameter(s)`;

      // `mergeParamsAtomic` (Issue #44) reads the CURRENT root `params.json`
      // and writes the result WHILE HOLDING the cross-process params lock, so
      // this can never race a concurrent `set_params` (or another REST
      // update) merging a DISJOINT key onto the same file.
      await asRouteResult(
        () =>
          mergeParamsAtomic(dir, plan.accepted, async (merged, ctx) => {
            if (request.snapshot !== false) {
              // The snapshot carries the CURRENT source unchanged — a
              // parameter write is not a model edit, and passing anything
              // else here would silently truncate `model.scad`. Reads
              // `ctx.projectDir`'s content THROUGH the ctx this callback
              // already holds (`readScadLocked`), never the exported
              // `readScad` -- that would re-enter the boundary and throw
              // immediately (Issue #73's non-reentrancy guard).
              const content = await readScadLocked(ctx);
              await createSnapshotLocked(ctx, { content, params: merged, message, origin: "manual", pass: null });
            } else {
              // S3-B ticket B4 (declared deviation, Tech Lead-approved): this
              // used to be a bare `writeFile` (`runtime.ts`'s
              // `writeRootParamsLocked`) -- exactly the "snapshot-free params
              // write" the staged roll-forward transaction mechanism now
              // owns. `updateRootParamsLocked` stages/decides/publishes ONLY
              // `params.json`, so a crash mid-write is recoverable like every
              // other root writer.
              await updateRootParamsLocked(ctx, merged);
            }
          }),
        "failed to persist the parameter update"
      );
      return paramsResponse(projectId);
    },

    // ── source (Issue #54) ──────────────────────────────────────────────────

    getSource: (projectId) => sourceResponse(projectId),

    async preflightSource(projectId, request: SourcePreflightRequest): Promise<SourcePreflightResponse> {
      const dir = runtime.dirFor(projectId);

      // Enforce the editor's base revision BEFORE doing any (slow) compile.
      const initial = await asRouteResult(() => coherentSourceState(dir), "failed to read source");
      if (initial.revision !== request.base_revision) {
        throw new RouteError("CONFLICT", "Source changed since you loaded it; refresh before continuing.");
      }

      // Compile the proposed source OUTSIDE the params lock.
      const scad = normalizeLineEndings(request.scad);
      const compiled = await asRouteResult(
        () => compileProposedSource(runtime, scad),
        "failed to compile proposed source"
      );

      // Re-check the revision inside the lock — a concurrent write that landed
      // during the compile must surface as CONFLICT, never a silent rebase.
      const current = await asRouteResult(() => coherentSourceState(dir), "failed to re-read source");
      if (current.revision !== request.base_revision) {
        throw new RouteError("CONFLICT", "Source changed while checking; refresh and try again.");
      }

      const analysis = analyzeSourceParams(compiled.schema, current.params, compiled.syntax_ok);
      return {
        revision: current.revision,
        syntax_ok: compiled.syntax_ok,
        diagnostics: compiled.diagnostics,
        parameters: compiled.schema.parameters as SourcePreflightResponse["parameters"],
        retained_params: analysis.retained_params,
        removed_params: analysis.removed_params
      };
    },

    async updateSource(projectId, request: SourceUpdateRequest): Promise<SourceResponse> {
      const dir = runtime.dirFor(projectId);
      const scad = normalizeLineEndings(request.scad);

      // Enforce base_revision before compiling.
      const initial = await asRouteResult(() => coherentSourceState(dir), "failed to read source");
      if (initial.revision !== request.base_revision) {
        throw new RouteError("CONFLICT", "Source changed since you loaded it; refresh before saving.");
      }

      // Compile outside the lock.
      const compiled = await asRouteResult(
        () => compileProposedSource(runtime, scad),
        "failed to compile proposed source"
      );
      if (!compiled.syntax_ok) {
        throw new RouteError("VALIDATION_FAILED", compiled.diagnostics ?? "Source does not parse.");
      }

      // Recompute the drop set server-side (never trust the client's preflight).
      const analysis = analyzeSourceParams(compiled.schema, initial.params, true);
      const removedNames = new Set(analysis.removed_params.map((r) => r.name));
      const discarded = request.discarded_params ?? [];
      const discardedSet = new Set(discarded);
      const missing = analysis.removed_params.filter((r) => !discardedSet.has(r.name)).map((r) => r.name);
      const extra = discarded.filter((name) => !removedNames.has(name));
      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`not acknowledged: ${missing.join(", ")}`);
        if (extra.length > 0) parts.push(`unexpected: ${extra.join(", ")}`);
        throw new RouteError(
          "VALIDATION_FAILED",
          `discarded_params must exactly match the overrides this edit drops (${parts.join("; ")}).`
        );
      }

      // Commit under a SECOND, sequential boundary entry, re-checking the
      // revision one last time so a concurrent write between the compile and
      // the commit can never be force-overwritten (Tech Lead correction:
      // "never hold the lock across the compile" -- two sequential entries,
      // never one held across the engine work, same pattern as `build`).
      //
      // NOTE: every throw inside this callback MUST be a `ScadForgeError`,
      // never `apps/server`'s `RouteError` -- same convention as
      // `submitEditorCommand` above (see its NOTE comment for why): a
      // `RouteError` thrown here would be flattened by scad-core's own
      // `withTypedError` to a generic `INTERNAL_ERROR`, silently losing this
      // CONFLICT (Issue #109). `asRouteResult`/`toRouteError` still convert
      // the `ScadForgeError` back into the equivalent `RouteError` once it
      // propagates past this boundary.
      await asRouteResult(
        () =>
          withRecoveredProject(dir, async (ctx) => {
            const current = await readProjectManifestLocked(ctx);
            const currentScad = await readScadLocked(ctx);
            const currentParams = await readParamsLocked(ctx);
            if (computeSourceRevision(current.head, currentScad, currentParams) !== request.base_revision) {
              throw new ScadForgeError("CONFLICT", "Source changed while saving; refresh and retry.");
            }
            await createSnapshotLocked(ctx, {
              content: scad,
              params: analysis.retained_params,
              message: "Edited source",
              origin: "manual",
              pass: null
            });
          }),
        "failed to save source"
      );

      return sourceResponse(projectId);
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

    // ── build (Issue #54) ───────────────────────────────────────────────────

    async build(projectId, request: BuildRequest): Promise<BuildResponse> {
      const dir = runtime.dirFor(projectId);

      // Enforce base_revision, then PIN the head snapshot id before any (slow)
      // render/validate work — a concurrent save that moves head mid-build must
      // not redirect this build's results onto a different snapshot.
      const state = await asRouteResult(() => coherentSourceState(dir), "failed to read source");
      if (state.revision !== request.base_revision) {
        throw new RouteError("CONFLICT", "Source changed since you loaded it; refresh before building.");
      }
      const pinned = state.head;
      if (!pinned) {
        throw new RouteError("INTERNAL_ERROR", "Project has no snapshot to build.");
      }

      // Render + validate the PINNED snapshot's OWN staged content, never the
      // project's current root state (Issue #45). Runs outside the params lock.
      const staged = await stageSnapshotModel(dir, pinned);
      const outDir = await mkdtemp(join(tmpdir(), "scadforge-build-"));
      try {
        const renderResult = await asRouteResult(
          () =>
            runRenderViews(
              { scadPath: staged.scadPath, outDir, views: DEFAULT_VIEWS, params: staged.params },
              { libraryPaths: runtime.libraryPaths }
            ),
          "build render failed"
        );
        assertCompleteBuildRender(renderResult);

        const attachments: RenderAttachment[] = renderResult.views
          .filter((view): view is RenderedView & { path: string } => view.ok && view.path !== null)
          .map((view) => ({
            view: view.view,
            sourcePath: view.path,
            render_ms: view.render_ms,
            width: view.imgsize[0],
            height: view.imgsize[1]
          }));

        if (attachments.length === 0) {
          throw new RouteError("RENDER_FAILED", renderResult.message ?? "Build produced no renders.");
        }
        // Each attach step is its OWN, sequential (never nested) boundary
        // entry, with the (slow) engine work between them running entirely
        // outside any lock -- Issue #73: "release lock for engine work;
        // recheck before mutable attachment". `pinned` was fixed before any
        // of this ran, so attaching to it stays correct however far the
        // project's head has since moved.
        await asRouteResult(
          () =>
            withRecoveredProject(dir, (ctx) =>
              attachRendersToSnapshotLocked(ctx, pinned, attachments, {
                buildRenderUrl: (snapshotId, view) => renderFileUrl(projectId, snapshotId, view)
              })
            ),
          "failed to attach renders"
        );

        const validation = await asRouteResult(
          () =>
            validateModel(staged.scadPath, {
              params: staged.params,
              libraryPaths: runtime.libraryPaths,
              persistMeshTo: snapshotMeshPath(dir, pinned)
            }),
          "build validation failed"
        );
        await asRouteResult(
          () => withRecoveredProject(dir, (ctx) => attachValidationToSnapshotLocked(ctx, pinned, validation)),
          "failed to attach validation"
        );
      } finally {
        await staged.cleanup();
        await rm(outDir, { recursive: true, force: true }).catch(() => {});
      }

      return {
        snapshot: await asRouteResult(() => readSnapshotManifest(dir, pinned), "failed to read built snapshot")
      };
    },

    // ── export ───────────────────────────────────────────────────────────────

    async runExport(projectId, request: ExportRequest): Promise<ExportResponse> {
      const dir = runtime.dirFor(projectId);
      const project = await readProject(dir);
      const outDir = exportsDir(dir);

      // Pin the head snapshot id BEFORE running the (slow) export, and --
      // unless the caller passed an explicit `params` override -- export THAT
      // PINNED snapshot's own staged `model.scad`/`params.json`, never
      // `rootModelPath(dir)` (Issue #45's AC5: the exported artifact and its
      // `ExportRecord.snapshot` must describe the SAME snapshot, immune to a
      // concurrent `write_scad`/`set_params` moving head mid-export).
      const isPreview = request.params !== undefined;
      const staged = project.head && !isPreview ? await stageSnapshotModel(dir, project.head) : null;

      const exportOutcome = await asRouteResult(async () => {
        try {
          return await exportRunWithValidation(
            {
              scadPath: staged?.scadPath ?? rootModelPath(dir),
              outDir,
              format: request.format,
              params: staged ? staged.params : request.params,
              allowValidationFailure: request.allow_validation_failure === true
            },
            { libraryPaths: runtime.libraryPaths }
          );
        } finally {
          await staged?.cleanup();
        }
      }, "export failed");

      const { result, validation } = exportOutcome;

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

      return {
        export: record,
        validation: validation
          ? {
              badge: validation.gate.badge,
              manifold: validation.report.manifold,
              components: validation.report.components,
              volume_mm3: validation.report.volume_mm3,
              warning_count: validation.gate.warnings.length
            }
          : null
      };
    },

    async getExportFile(projectId, file): Promise<RenderFile | null> {
      const dir = runtime.dirFor(projectId);
      // `PROJECT_LAYOUT.exportsDir` is the only directory this may reach; the
      // route has already rejected any `file` that is not a bare path segment.
      if (file === PROJECT_LAYOUT.snapshot.manifestFile) return null;
      return readFileOrNull(join(exportsDir(dir), file));
    },

    // ── editor (S3-B B5, Issue #91) ───────────────────────────────────────
    async verifyEditorCommand(projectId, request): Promise<EditorProofResponse> {
      const dir = runtime.dirFor(projectId);

      const state = await asRouteResult(() => coherentSourceState(dir), "failed to read the coherent editor state");

      // Story seam ("Source fingerprint and unreadable-sidecar revision",
      // settled 2026-09-14): a sidecar that is not `ready`/`legacy-empty`
      // supports no editor command at all, whatever revision the client
      // sent -- `coherentSourceState`'s `editorRevision` is `null` in
      // exactly this case, so it can never equal a real (64-hex) client
      // revision below; this check gives that a clearer refusal reason.
      if (state.sidecarStatus !== "ready" && state.sidecarStatus !== "legacy-empty") {
        throw new RouteError("CONFLICT", `Editor commands are unsupported while the sidecar status is "${state.sidecarStatus}".`);
      }
      if (state.editorRevision !== request.baseEditorRevision) {
        throw new RouteError("CONFLICT", "The base editor revision is stale; refresh and retry.");
      }

      // Schema comes from the exact pinned source text just read under the
      // lock (never a fresh re-read of the root file), the same
      // compile-outside/recheck-inside split `compileProposedSource`
      // documents on itself -- there is no unlocked window where the probe
      // could compile against source that has since moved.
      const compiled = await asRouteResult(() => compileProposedSource(runtime, state.scad), "failed to read the parameter schema");
      if (!compiled.syntax_ok) {
        throw new RouteError("RENDER_FAILED", "The project's committed source failed to syntax-check.");
      }

      const probeResult = await asRouteResult(
        () =>
          runProbe({
            projectId,
            baseEditorRevision: request.baseEditorRevision,
            scad: state.scad,
            authoritativeParams: state.params,
            schema: compiled.schema,
            features: state.sidecarFeatures,
            command: request.command,
            intent: request.intent,
            traversal: request.traversal,
            libraryPaths: runtime.libraryPaths
          }),
        "proof probe failed"
      );

      if (probeResult.status === "refused") {
        throw new RouteError("VALIDATION_FAILED", probeResult.reason);
      }

      await asRouteResult(() => persistProofRecord(dir, probeResult.record), "failed to persist the proof record");

      return {
        version: 1,
        proofId: probeResult.record.proofId,
        commandDigest: probeResult.record.commandDigest,
        baseEditorRevision: probeResult.record.baseEditorRevision,
        expiresAt: probeResult.record.expiresAt
      };
    },

    getEditorDocument: (projectId) => editorDocumentResponse(projectId),

    submitEditorCommand,

    async getEditorOperation(projectId, operationId): Promise<EditorOperationResponse> {
      const dir = runtime.dirFor(projectId);
      return asRouteResult(
        () => withRecoveredProject(dir, async (ctx) => toEditorOperationResponse(await lookupClaimLocked(ctx, operationId))),
        "failed to read the operation"
      );
    }
  };
}
