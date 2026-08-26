// SPDX-License-Identifier: Apache-2.0
//
// In-memory implementations of the two seams.
//
// Shipped (not test-only) on purpose: `apps/server` (Issue #17) and
// `packages/mcp-server` (M4) both need a no-Docker fixture to test their wiring
// against, and duplicating one in each package is how they drift.

import type {
  ExportRunResult,
  LibrarySymbol,
  ParamSchema,
  ParamValues,
  RenderResult,
  RenderedView,
  ValidationGateResult,
  ValidationReport,
  ValidationResult,
  ViewName
} from "@scadforge/scad-core";
import { DEFAULT_VIEWS, VIEW_CAMERA_ARGS } from "@scadforge/scad-core";
import type { SnapshotManifest, ToolArtifact } from "@scadforge/protocol";
import type {
  AgentExportRequest,
  AgentRenderRequest,
  AgentValidateRequest,
  LibraryIndexApi,
  ProjectState,
  ScadCoreApi,
  SetParamsOutcome,
  WriteScadOutcome,
  WriteScadRequest
} from "../tools/scad-core-api.js";

/** A green, single-component validation report. */
export function healthyReport(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    manifold: true,
    status: "NoError",
    volume_mm3: 1234.5,
    surface_area: 987.6,
    bbox: { min: [0, 0, 0], max: [20, 20, 10] },
    triangle_count: 512,
    components: 1,
    genus: 0,
    ...overrides
  };
}

/** A passing gate. */
export function greenGate(overrides: Partial<ValidationGateResult> = {}): ValidationGateResult {
  return { ok: true, badge: "green", failures: [], warnings: [], ...overrides };
}

/** A failing gate: the model came out in two disconnected pieces. */
export function redGate(overrides: Partial<ValidationGateResult> = {}): ValidationGateResult {
  return {
    ok: false,
    badge: "red",
    failures: [{ code: "MULTIPLE_COMPONENTS", message: "The mesh has 2 disconnected components." }],
    warnings: [],
    ...overrides
  };
}

/** A snapshot manifest with plausible defaults. */
export function snapshot(id: string, overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    id,
    parent: null,
    timestamp: "2026-08-26T00:00:00.000Z",
    message: "model updated",
    origin: "agent",
    pass: 1,
    files: {
      model_scad: "model.scad",
      params_json: "params.json",
      message_md: "message.md",
      validation_json: null,
      diff_patch: null
    },
    params: {},
    renders: [],
    validation: null,
    annotations: [],
    ...overrides
  };
}

/** One successfully rendered view. */
export function renderedView(view: ViewName, overrides: Partial<RenderedView> = {}): RenderedView {
  return {
    view,
    ok: true,
    path: `/tmp/scadforge/${view}.png`,
    camera: VIEW_CAMERA_ARGS[view],
    projection: "ortho",
    imgsize: [1024, 768],
    bytes: 4096,
    render_ms: 900,
    stderr: null,
    ...overrides
  };
}

/** Programmable behaviour for {@link MockScadCore}. */
export interface MockScadCoreOptions {
  scad?: string;
  params?: ParamValues;
  paramSchema?: ParamSchema;
  validation?: ValidationReport | null;
  headSnapshot?: string | null;
  /** Syntax errors reported by the next `write_scad`. Empty means clean. */
  syntaxErrors?: string[];
  /** Result the next `render_views` produces. */
  render?: RenderResult;
  /** Result the next `validate_mesh` produces. */
  validate?: ValidationResult;
  /** Result the next `export` produces. */
  exportResult?: ExportRunResult;
  /** Base64 returned for every render. */
  imageBase64?: string;
  /** Throw this instead of answering — keyed by method name. */
  failures?: Partial<Record<keyof ScadCoreApi, unknown>>;
}

/** A fully in-memory {@link ScadCoreApi}. No OpenSCAD, no Docker, no filesystem. */
export class MockScadCore implements ScadCoreApi {
  /** Every call made, for assertions. */
  readonly calls: Array<{ method: string; payload: unknown }> = [];

  scad: string;
  params: ParamValues;
  paramSchema: ParamSchema;
  validation: ValidationReport | null;
  headSnapshot: string | null;
  syntaxErrors: string[];
  imageBase64: string;
  render?: RenderResult;
  validate?: ValidationResult;
  exportResult?: ExportRunResult;
  failures: Partial<Record<keyof ScadCoreApi, unknown>>;

  private snapshotCounter = 0;

  constructor(options: MockScadCoreOptions = {}) {
    this.scad = options.scad ?? "cube(10);\n";
    this.params = options.params ?? { size: 10 };
    this.paramSchema =
      options.paramSchema ?? { title: "model", parameters: [{ name: "size", type: "number", initial: 10 }] };
    this.validation = options.validation ?? null;
    this.headSnapshot = options.headSnapshot ?? null;
    this.syntaxErrors = options.syntaxErrors ?? [];
    this.imageBase64 = options.imageBase64 ?? "aGVsbG8=";
    this.render = options.render;
    this.validate = options.validate;
    this.exportResult = options.exportResult;
    this.failures = options.failures ?? {};
  }

  private guard(method: keyof ScadCoreApi): void {
    if (method in this.failures) throw this.failures[method];
  }

  async readProject(): Promise<ProjectState> {
    this.calls.push({ method: "readProject", payload: null });
    this.guard("readProject");
    return {
      scad: this.scad,
      params: this.params,
      param_schema: this.paramSchema,
      validation: this.validation,
      head_snapshot: this.headSnapshot
    };
  }

  async writeScad(request: WriteScadRequest): Promise<WriteScadOutcome> {
    this.calls.push({ method: "writeScad", payload: request });
    this.guard("writeScad");
    this.scad = request.content;
    const ok = this.syntaxErrors.length === 0;
    this.snapshotCounter += 1;
    return {
      bytes: Buffer.byteLength(request.content, "utf8"),
      syntax_check: { ok, errors: this.syntaxErrors, warnings: [], ms: 12 },
      snapshot: ok
        ? snapshot(String(this.snapshotCounter).padStart(4, "0"), {
            message: request.message,
            pass: request.pass
          })
        : null
    };
  }

  async setParams(params: ParamValues, pass: number): Promise<SetParamsOutcome> {
    this.calls.push({ method: "setParams", payload: { params, pass } });
    this.guard("setParams");
    const known = new Set(this.paramSchema.parameters.map((p) => p.name));
    const unknown = Object.keys(params).filter((name) => !known.has(name));
    for (const [name, value] of Object.entries(params)) if (known.has(name)) this.params[name] = value;
    this.snapshotCounter += 1;
    return {
      params: this.params,
      unknown_params: unknown,
      snapshot: snapshot(String(this.snapshotCounter).padStart(4, "0"), { origin: "manual", pass })
    };
  }

  async renderViews(request: AgentRenderRequest): Promise<RenderResult> {
    this.calls.push({ method: "renderViews", payload: request });
    this.guard("renderViews");
    if (this.render) return this.render;
    const views = (request.views?.length ? request.views : DEFAULT_VIEWS) as readonly ViewName[];
    return { ok: true, views: views.map((view) => renderedView(view)), total_ms: views.length * 900 };
  }

  async validateMesh(request: AgentValidateRequest): Promise<ValidationResult> {
    this.calls.push({ method: "validateMesh", payload: request });
    this.guard("validateMesh");
    return this.validate ?? { report: healthyReport(), gate: greenGate(), export_ms: 800, validate_ms: 40 };
  }

  async exportModel(request: AgentExportRequest): Promise<ExportRunResult> {
    this.calls.push({ method: "exportModel", payload: request });
    this.guard("exportModel");
    if (this.exportResult) return this.exportResult;
    return {
      ok: true,
      path: `/tmp/scadforge/exports/model.${request.format}`,
      format: request.format,
      bytes: 20480,
      export_ms: 1500,
      validation: greenGate(),
      validation_overridden: false
    };
  }

  async readImageBase64(absolutePath: string): Promise<string> {
    this.calls.push({ method: "readImageBase64", payload: absolutePath });
    this.guard("readImageBase64");
    return this.imageBase64;
  }

  artifactUrl(kind: ToolArtifact["kind"], ref: string): string | null {
    return `/api/artifacts/${kind}/${ref.replace(/^\//, "")}`;
  }

  exportFileName(absolutePath: string): string {
    return absolutePath.split("/").pop() ?? absolutePath;
  }
}

/** An in-memory {@link LibraryIndexApi} over a fixed symbol list. */
export class MockLibraryIndex implements LibraryIndexApi {
  constructor(
    private readonly symbols: LibrarySymbol[] = [
      {
        library: "BOSL2",
        name: "cuboid",
        kind: "module",
        signature: "cuboid(size, [rounding], [chamfer], [anchor])",
        file: "shapes3d.scad",
        summary: "A cube with optional rounding or chamfering.",
        examples: ["cuboid([20,20,10], rounding=2);"],
        include: "include <BOSL2/std.scad>"
      }
    ],
    private readonly failure?: unknown
  ) {}

  async lookup(request: { query: string; library?: string; limit?: number }): Promise<LibrarySymbol[]> {
    if (this.failure) throw this.failure;
    const matches = this.symbols.filter(
      (symbol) =>
        (!request.library || symbol.library === request.library) &&
        (symbol.name.includes(request.query) || symbol.summary.toLowerCase().includes(request.query.toLowerCase()))
    );
    return matches.slice(0, request.limit ?? 5);
  }
}
