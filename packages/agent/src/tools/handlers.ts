// SPDX-License-Identifier: Apache-2.0
//
// The seven tool handlers, as a FACTORY over the `ScadCoreApi` /
// `LibraryIndexApi` seams.
//
// Nothing here knows about the Claude Agent SDK: the factory returns plain
// `(input) => Promise<ToolCallResult>` functions, so `packages/mcp-server` (M4)
// can serve the identical behaviour over stdio, and the unit tests can drive
// every path with an in-memory mock — no Docker, no OpenSCAD, no API key.

import type { ScadForgeErrorCode, SnapshotManifest, SseEvent, ToolArtifact } from "@scadforge/protocol";
import type { RenderedView, ViewName } from "@scadforge/scad-core";
import { DEFAULT_VIEWS } from "@scadforge/scad-core";

import {
  TOOL_NAMES,
  type ToolCallResult,
  type ToolContentBlock,
  type ToolInput,
  type ToolName
} from "./contract.js";
import type { LibraryIndexApi, ScadCoreApi } from "./scad-core-api.js";
import type { PassBudget } from "./pass-budget.js";
import type { ToolActivity, ToolActivityRecorder } from "./activity.js";
import {
  errorMessage,
  failureResult,
  filterStderr,
  imageBlock,
  imageLabelBlock,
  jsonBlock,
  successResult,
  toErrorCode,
  toolResult
} from "./results.js";
import { sanitizeChatText } from "../sanitize.js";

/** One tool handler. */
export type ToolHandler<T extends ToolName> = (input: ToolInput<T>) => Promise<ToolCallResult>;

/** All seven handlers, keyed by unprefixed tool name. */
export type ToolHandlerMap = { [K in ToolName]: ToolHandler<K> };

/** What {@link createToolHandlers} needs. */
export interface ToolHandlerDeps {
  scadCore: ScadCoreApi;
  libraries: LibraryIndexApi;
  budget: PassBudget;
  activity: ToolActivityRecorder;
  /** Turn identity, for the `snapshot_created` events handlers emit directly. */
  turnId: string;
  projectId: string;
  /**
   * Sink for the frozen SSE union. Handlers use it ONLY for
   * `snapshot_created`, which has no Claude Agent SDK equivalent (Spike 3 §6);
   * `tool_call` / `tool_result` are emitted by the provider, which is the only
   * layer that knows the SDK's `tool_call_id`.
   */
  emit: (event: SseEvent) => void;
}

/** Maximum characters of a snapshot message (`writeScadInputShape.message`). */
const MAX_SNAPSHOT_MESSAGE = 200;

/** The note that explains block ordering and the section view to the model. */
const RENDER_NOTE =
  "The labelled images below follow in the same order as `views`. " +
  '"section" is the model cut by a half-space on Y so internal walls and holes are visible. ' +
  "Look at every image before deciding the model is correct.";

function artifact(
  kind: ToolArtifact["kind"],
  url: string | null,
  view: ViewName | null,
  bytes: number | null
): ToolArtifact[] {
  return url ? [{ kind, view, url, bytes }] : [];
}

function snapshotEvent(
  manifest: SnapshotManifest,
  turnId: string,
  projectId: string
): Extract<SseEvent, { type: "snapshot_created" }> {
  return { type: "snapshot_created", turn_id: turnId, project_id: projectId, snapshot: manifest };
}

/**
 * Build the seven handlers.
 *
 * Every handler:
 * - stamps the current pass into its JSON envelope;
 * - records a {@link ToolActivity} so the provider can emit a faithful
 *   `tool_result` event;
 * - turns a rejection from the CAD seam into a NON-error result carrying
 *   `{ok:false, error_code, message}` — `isError: true` is never set, because
 *   the SDK collapses such a result's content to a string and drops images
 *   (`TOOL_RESULT_RULES.neverIsErrorWithImages`).
 */
export function createToolHandlers(deps: ToolHandlerDeps): ToolHandlerMap {
  const { scadCore, libraries, budget, activity, emit, turnId, projectId } = deps;

  /** Record an activity and hand the result back unchanged. */
  function record(entry: Omit<ToolActivity, "artifacts" | "images"> & Partial<ToolActivity>): void {
    activity.push({ artifacts: [], images: 0, ...entry });
  }

  function failed(
    name: ToolName,
    startedAt: number,
    code: ScadForgeErrorCode,
    message: string,
    extra: Record<string, unknown> = {}
  ): ToolCallResult {
    record({
      name,
      pass: budget.pass,
      ok: false,
      error_code: code,
      summary: message,
      duration_ms: Date.now() - startedAt
    });
    return failureResult(code, message, { pass: budget.pass, ...extra });
  }

  const readProject: ToolHandler<"read_project"> = async () => {
    const startedAt = Date.now();
    let state;
    try {
      state = await scadCore.readProject();
    } catch (error) {
      return failed("read_project", startedAt, toErrorCode(error, "PROJECT_NOT_FOUND"), errorMessage(error));
    }
    record({
      name: "read_project",
      pass: budget.pass,
      ok: true,
      error_code: null,
      summary: `${state.param_schema.parameters.length} parameters, head ${state.head_snapshot ?? "none"}`,
      duration_ms: Date.now() - startedAt
    });
    return successResult({
      ok: true,
      pass: budget.pass,
      scad: state.scad,
      params: state.params,
      param_schema: state.param_schema,
      validation: state.validation,
      head_snapshot: state.head_snapshot
    });
  };

  const writeScad: ToolHandler<"write_scad"> = async ({ content, message }) => {
    const startedAt = Date.now();

    // ── The 2-pass cap lives HERE (contract.ts PASS_BUDGET_ENFORCEMENT) ──────
    const refusal = budget.refusalReason();
    if (refusal) {
      const explanation =
        refusal === "budget"
          ? `Pass budget of ${budget.maxPasses} exhausted (SCADFORGE_MAX_PASSES). Do not write again. ` +
            "Stop now and hand back a short summary of the current state, naming any defect you could not fix."
          : "Validation is already green for the current model. The turn is finished: do not write again. " +
            "Hand back a short summary of what you built and the parameters you exposed.";
      record({
        name: "write_scad",
        pass: budget.pass,
        ok: false,
        error_code: "PASS_BUDGET_EXHAUSTED",
        summary: explanation,
        duration_ms: Date.now() - startedAt,
        refusal
      });
      return failureResult("PASS_BUDGET_EXHAUSTED", explanation, {
        pass: budget.pass,
        max_passes: budget.maxPasses,
        passes_remaining: budget.passesRemaining
      });
    }

    const pass = budget.openPass();
    // CLAUDE.md hard rule 5: this string reaches the chat transcript and the
    // snapshot manifest, so it is stripped host-side, not merely prompted for.
    const safeMessage = sanitizeChatText(message, MAX_SNAPSHOT_MESSAGE) || "model updated";

    let outcome;
    try {
      outcome = await scadCore.writeScad({ content, message: safeMessage, pass });
    } catch (error) {
      return failed("write_scad", startedAt, toErrorCode(error, "INTERNAL_ERROR"), errorMessage(error), {
        max_passes: budget.maxPasses,
        passes_remaining: budget.passesRemaining
      });
    }

    if (outcome.snapshot) emit(snapshotEvent(outcome.snapshot, turnId, projectId));

    // `TOOL_RESULT_RULES.echoBudgetState`: always echo the budget so the model
    // self-paces instead of discovering the cap by hitting it.
    const budgetState = {
      pass,
      max_passes: budget.maxPasses,
      passes_remaining: budget.passesRemaining,
      bytes: outcome.bytes,
      snapshot: outcome.snapshot?.id ?? null,
      syntax_check: outcome.syntax_check
    };

    const artifacts = outcome.snapshot
      ? artifact("snapshot", scadCore.artifactUrl("snapshot", outcome.snapshot.id), null, null)
      : [];

    if (!outcome.syntax_check.ok) {
      const message0 =
        outcome.syntax_check.errors[0] ?? "OpenSCAD rejected the file, but reported no ERROR: line.";
      record({
        name: "write_scad",
        pass,
        ok: false,
        error_code: "SYNTAX_ERROR",
        summary: message0,
        artifacts,
        duration_ms: Date.now() - startedAt
      });
      // Superset of the failure envelope: the budget echo is mandatory on EVERY
      // `write_scad` result, and the success schema cannot express `ok: false`.
      return failureResult("SYNTAX_ERROR", message0, budgetState);
    }

    record({
      name: "write_scad",
      pass,
      ok: true,
      error_code: null,
      summary: safeMessage,
      artifacts,
      duration_ms: Date.now() - startedAt
    });
    return successResult({ ok: true, ...budgetState });
  };

  const setParams: ToolHandler<"set_params"> = async ({ params }) => {
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await scadCore.setParams(params, budget.pass);
    } catch (error) {
      return failed("set_params", startedAt, toErrorCode(error, "INVALID_REQUEST"), errorMessage(error));
    }
    if (outcome.snapshot) emit(snapshotEvent(outcome.snapshot, turnId, projectId));

    const names = Object.keys(params);
    record({
      name: "set_params",
      pass: budget.pass,
      ok: true,
      error_code: null,
      summary:
        names.length === 0
          ? "no parameters supplied"
          : `set ${names.length - outcome.unknown_params.length}/${names.length} parameters`,
      artifacts: outcome.snapshot
        ? artifact("snapshot", scadCore.artifactUrl("snapshot", outcome.snapshot.id), null, null)
        : [],
      duration_ms: Date.now() - startedAt
    });
    return successResult({
      ok: true,
      pass: budget.pass,
      params: outcome.params,
      unknown_params: outcome.unknown_params,
      snapshot: outcome.snapshot?.id ?? null
    });
  };

  const renderViews: ToolHandler<"render_views"> = async ({ views, imgsize, params }) => {
    const startedAt = Date.now();
    let result;
    try {
      result = await scadCore.renderViews({ views, imgsize, params });
    } catch (error) {
      // A thrown render (e.g. the subprocess timeout) yields a LABELLED,
      // image-less, NON-error result: the model must be able to read why.
      const stderr = filterStderr(
        typeof (error as { stderr?: unknown })?.stderr === "string" ? (error as { stderr: string }).stderr : null
      );
      return failed("render_views", startedAt, toErrorCode(error, "RENDER_FAILED"), errorMessage(error), {
        views: [],
        total_ms: Date.now() - startedAt,
        stderr
      });
    }

    const requested: readonly ViewName[] = views?.length ? views : DEFAULT_VIEWS;
    const summaries = result.views.map((view: RenderedView) => ({
      view: view.view,
      ok: view.ok,
      camera: view.camera,
      projection: view.projection,
      imgsize: [view.imgsize[0], view.imgsize[1]] as [number, number],
      bytes: view.bytes,
      render_ms: view.render_ms,
      stderr: filterStderr(view.stderr)
    }));

    const payload: Record<string, unknown> = {
      ok: result.ok,
      pass: budget.pass,
      views: summaries,
      total_ms: result.total_ms,
      note: RENDER_NOTE
    };
    if (!result.ok) {
      payload.error_code = result.error_code ?? "RENDER_FAILED";
      payload.message =
        result.message ??
        `Rendered ${result.views.filter((v) => v.ok).length}/${requested.length} requested views.`;
    }

    const content: ToolContentBlock[] = [jsonBlock(payload)];
    const artifacts: ToolArtifact[] = [];
    let images = 0;

    for (const view of result.views) {
      if (!view.ok || !view.path) continue;
      const url = scadCore.artifactUrl("render", view.path);
      if (url) artifacts.push({ kind: "render", view: view.view, url, bytes: view.bytes });
      try {
        const data = await scadCore.readImageBase64(view.path);
        // Label block IMMEDIATELY before the image (TOOL_RESULT_RULES).
        content.push(imageLabelBlock(view.view), imageBlock(data));
        images += 1;
      } catch {
        // A PNG we cannot read is not worth failing the whole result over; the
        // per-view JSON already tells the model what happened.
      }
    }

    record({
      name: "render_views",
      pass: budget.pass,
      ok: result.ok,
      error_code: result.ok ? null : (result.error_code ?? "RENDER_FAILED"),
      summary: `${images} of ${requested.length} views rendered`,
      artifacts,
      images,
      duration_ms: Date.now() - startedAt
    });
    // NEVER `isError: true` on a result that carries images.
    return toolResult(...content);
  };

  const validateMesh: ToolHandler<"validate_mesh"> = async ({ params, allowMultiPart }) => {
    const startedAt = Date.now();
    let result;
    try {
      result = await scadCore.validateMesh({ params, allowMultiPart });
    } catch (error) {
      budget.recordValidation(false);
      return failed("validate_mesh", startedAt, toErrorCode(error, "MESH_PARSE_FAILED"), errorMessage(error));
    }

    // "Stop early on green validation" (CLAUDE.md hard rule 4) is decided here:
    // a green gate closes the turn's write budget.
    const green = result.gate.ok && result.gate.badge === "green";
    budget.recordValidation(green);

    record({
      name: "validate_mesh",
      pass: budget.pass,
      ok: result.gate.ok,
      error_code: result.gate.ok ? null : "VALIDATION_FAILED",
      summary: `${result.gate.badge}: manifold=${result.report.manifold} components=${result.report.components ?? "n/a"}`,
      artifacts: [],
      duration_ms: Date.now() - startedAt
    });

    return successResult({
      ok: result.gate.ok,
      pass: budget.pass,
      report: result.report,
      gate: result.gate,
      export_ms: result.export_ms,
      validate_ms: result.validate_ms
    });
  };

  const exportModel: ToolHandler<"export"> = async ({ format, params, allowValidationFailure }) => {
    const startedAt = Date.now();
    let result;
    try {
      result = await scadCore.exportModel({ format, params, allowValidationFailure });
    } catch (error) {
      return failed("export", startedAt, toErrorCode(error, "EXPORT_FAILED"), errorMessage(error), {
        format,
        file: null,
        bytes: null,
        export_ms: Date.now() - startedAt,
        validation: null,
        validation_overridden: allowValidationFailure === true
      });
    }

    const file = result.path ? scadCore.exportFileName(result.path) : null;
    const payload: Record<string, unknown> = {
      ok: result.ok,
      pass: budget.pass,
      format: result.format,
      file,
      bytes: result.bytes,
      export_ms: result.export_ms,
      validation: result.validation,
      validation_overridden: result.validation_overridden
    };
    if (!result.ok) {
      payload.error_code =
        result.error_code ?? (result.validation && !result.validation.ok ? "VALIDATION_FAILED" : "EXPORT_FAILED");
      payload.message =
        result.message ??
        (result.validation?.failures.map((f) => f.message).join("; ") || "The export could not be produced.");
    }

    record({
      name: "export",
      pass: budget.pass,
      ok: result.ok,
      error_code: result.ok ? null : ((payload.error_code as ScadForgeErrorCode | undefined) ?? "EXPORT_FAILED"),
      summary: result.ok ? `${result.format} → ${file}` : String(payload.message),
      artifacts: result.path ? artifact("export", scadCore.artifactUrl("export", result.path), null, result.bytes) : [],
      duration_ms: Date.now() - startedAt
    });
    return successResult(payload);
  };

  const libraryLookup: ToolHandler<"library_lookup"> = async ({ query, library, limit }) => {
    const startedAt = Date.now();
    let matches;
    try {
      matches = await libraries.lookup({ query, library, limit });
    } catch (error) {
      return failed("library_lookup", startedAt, toErrorCode(error, "LIBRARY_UNAVAILABLE"), errorMessage(error), {
        query,
        matches: []
      });
    }
    record({
      name: "library_lookup",
      pass: budget.pass,
      ok: true,
      error_code: null,
      summary: `${matches.length} matches for "${query}"`,
      duration_ms: Date.now() - startedAt
    });
    return successResult({ ok: true, pass: budget.pass, query, matches });
  };

  const handlers: ToolHandlerMap = {
    read_project: readProject,
    write_scad: writeScad,
    set_params: setParams,
    render_views: renderViews,
    validate_mesh: validateMesh,
    export: exportModel,
    library_lookup: libraryLookup
  };

  // Cheap guard against the map and the frozen contract drifting apart.
  for (const name of TOOL_NAMES) {
    if (typeof handlers[name] !== "function") {
      throw new Error(`createToolHandlers: no handler registered for "${name}"`);
    }
  }
  return handlers;
}
