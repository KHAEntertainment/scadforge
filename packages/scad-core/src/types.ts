// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — ScadForge Issue #13.
//
// This file is Tech-Lead-owned now that Issue #13 has merged (CLAUDE.md hard
// rule 2 / PROJECT_CONTEXT.md "Contract freeze rule"). Do NOT edit it inside a
// feature PR. Changes require a Tech-Lead-approved contract-change issue,
// merged separately before any dependent work.
//
// SPDX-License-Identifier: Apache-2.0
// ─────────────────────────────────────────────────────────────────────────────
//
// @scadforge/scad-core — the CAD domain contract.
//
// Canonical home for: the Customizer parameter model, the fixed view set and
// its frozen camera constants, the section-view two-pass contract, the render
// request/result shapes, the `ValidationReport` and its gate thresholds, and
// the export shapes. Runtime implementations (params/, store/, validate/,
// runner/) build against these; none of them live here.
//
// All geometry is in millimetres (CLAUDE.md "Units & conventions").
// ─────────────────────────────────────────────────────────────────────────────

import type { ScadForgeErrorCode, ValidationBadge } from "@scadforge/protocol";

// ═════════════════════════════════════════════════════════════════════════════
// 1. Customizer parameter model
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A single Customizer parameter value.
 *
 * CANONICAL definition — `@scadforge/protocol` mirrors this as `ParamValue`
 * because it has zero dependencies and cannot import from here. Drift is
 * guarded by `types.test.ts`.
 */
export type ParamValue = number | string | boolean | number[] | string[] | boolean[];

/** A `{name: value}` bag of Customizer parameter values. */
export type ParamValues = Record<string, ParamValue>;

/**
 * Parameter types emitted by OpenSCAD's `--export-format=param`
 * (verified against Spike 2's sample output, which produced only `number`;
 * the other three are OpenSCAD's remaining Customizer types).
 */
export type ParamType = "number" | "boolean" | "string" | "vector";

/** One entry of a dropdown parameter, from `// [a, b, c]` or `// [1:One, 2:Two]`. */
export interface ParamOption {
  /** Display label. Equals `String(value)` for a bare `// [a, b, c]` list. */
  name: string;
  value: ParamValue;
}

/**
 * One parameter, mapped 1:1 onto an object in the `parameters` array of
 * OpenSCAD's `--export-format=param` JSON. Field names are OpenSCAD's, NOT
 * camelCased, so the CLI output can be consumed without a rename layer.
 *
 * Spike 2 §"AC verification" item 4, verbatim sample entry:
 * ```json
 * {"caption":"Bracket wall thickness","group":"Pipe","initial":4.0,
 *  "max":10.0,"min":2.0,"name":"wall","step":0.5,"type":"number"}
 * ```
 */
export interface ParamDefinition {
  /** The OpenSCAD variable name. */
  name: string;
  type: ParamType;
  /** The value assigned in the `.scad` source — the slider's default. */
  initial: ParamValue;
  /** Trailing `// description` comment on the assignment line. */
  caption?: string;
  /** The enclosing `/* [Section] *\/` group, if any. */
  group?: string;
  /** From `// [min:max]` or `// [min:step:max]`. Numbers only. */
  min?: number;
  /** From `// [min:max]` or `// [min:step:max]`. Numbers only. */
  max?: number;
  /** From `// [min:step:max]`. Numbers only. */
  step?: number;
  /** From `// N` on a string parameter. */
  maxLength?: number;
  /** From `// [a, b, c]` — renders as a dropdown instead of a slider. */
  options?: ParamOption[];
}

/**
 * The full `--export-format=param` document.
 *
 * Preferred acquisition path (SDP §7): run the pinned OpenSCAD CLI with
 * `--export-format=param`; the openscad-playground comment parser is the
 * fallback only.
 */
export interface ParamSchema {
  /** OpenSCAD emits the model file's stem here (e.g. `"sample"`). */
  title: string;
  parameters: ParamDefinition[];
}

/**
 * A value as stored in `params.json`. OpenSCAD writes every preset value as a
 * STRING but accepts numbers and booleans on read, so both are permitted here.
 * Convert to {@link ParamValue} against the {@link ParamSchema} before use.
 */
export type ParamPresetValue = string | number | boolean | Array<string | number | boolean>;

/**
 * `params.json` — OpenSCAD Customizer preset format (SDP §8). Consumed by the
 * CLI as `-p params.json -P <preset>`.
 */
export interface ParamsFile {
  /** OpenSCAD's preset-file version marker. */
  fileFormatVersion: string;
  /** Keyed by preset name; ScadForge writes exactly one, {@link PARAMS_ACTIVE_PRESET}. */
  parameterSets: Record<string, Record<string, ParamPresetValue>>;
}

/** The `fileFormatVersion` ScadForge writes into `params.json`. */
export const PARAMS_FILE_FORMAT_VERSION = "1";

/**
 * The single preset name ScadForge maintains in `params.json`, passed to the
 * CLI as `-P current` (matches Spike 3's working loop).
 */
export const PARAMS_ACTIVE_PRESET = "current";

// ═════════════════════════════════════════════════════════════════════════════
// 2. Views and frozen camera constants
//
// Source of truth: PROJECT_CONTEXT.md "Spike Decisions" → render_views camera
// constants, verified end-to-end in Spike 2 (docs/spikes/02-docker-cli).
// These values are byte-matched by types.test.ts. Do not "tidy" them.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The five fixed views.
 *
 * CANONICAL definition — mirrored by `@scadforge/protocol` (see that package's
 * `vocabulary.ts` MIRROR notice); drift is guarded by `types.test.ts`.
 */
export const VIEW_NAMES = ["iso", "front", "top", "right", "section"] as const;

/** One of the five fixed views. */
export type ViewName = (typeof VIEW_NAMES)[number];

/**
 * The default view set for `render_views`.
 *
 * SPIKE OVERRIDES SDP: SDP §6.2 lists all five, but Spike 3 §8 found the `top`
 * preset near-useless on flat-topped parts (orthographic + head-on + no
 * shading makes coplanar features vanish — it produced an honest
 * `NO_CHARACTERS_VISIBLE` on a legibility probe). `top` stays in
 * {@link VIEW_NAMES} and is rendered on explicit request.
 */
export const DEFAULT_VIEWS = ["iso", "front", "right", "section"] as const satisfies readonly ViewName[];

/** The `rx,ry,rz` triple of OpenSCAD's gimbal `--camera=tx,ty,tz,rx,ry,rz,dist`. */
export type CameraRotation = readonly [rx: number, ry: number, rz: number];

/**
 * FROZEN per-view camera rotations (PROJECT_CONTEXT.md Spike Decisions:
 * "rotations iso `55,0,25`, front `90,0,0`, top `0,0,0`, right `90,0,90`").
 *
 * Only `rx,ry,rz` are load-bearing: `--autocenter` recomputes `tx,ty,tz` and
 * `--viewall` recomputes `dist`, so those are always passed as `0` placeholders
 * (see {@link VIEW_CAMERA_ARGS}).
 *
 * `section` reuses `front`'s camera (Spike 2 "Camera constants" table).
 */
export const VIEW_CAMERA_ROTATIONS = {
  iso: [55, 0, 25],
  front: [90, 0, 0],
  top: [0, 0, 0],
  right: [90, 0, 90],
  section: [90, 0, 0]
} as const satisfies Record<ViewName, CameraRotation>;

/**
 * The literal `--camera=` argument value for each view, in OpenSCAD's gimbal
 * form `tx,ty,tz,rx,ry,rz,dist`. Pass verbatim; do not rebuild by string
 * concatenation at call sites.
 */
export const VIEW_CAMERA_ARGS = {
  iso: "0,0,0,55,0,25,0",
  front: "0,0,0,90,0,0,0",
  top: "0,0,0,0,0,0,0",
  right: "0,0,0,90,0,90,0",
  section: "0,0,0,90,0,0,0"
} as const satisfies Record<ViewName, string>;

/**
 * FROZEN common flags applied to EVERY view render, verbatim from
 * PROJECT_CONTEXT.md Spike Decisions:
 *
 * `--viewall --autocenter --projection=ortho --imgsize=1024,768
 *  --backend=Manifold --render --colorscheme=Cornfield`
 *
 * `--colorscheme=Cornfield` and a pinned `$fn` are what make renders
 * byte-identical across repeat invocations (Spike 2 AC 5).
 */
export const RENDER_COMMON_FLAGS = [
  "--viewall",
  "--autocenter",
  "--projection=ortho",
  "--imgsize=1024,768",
  "--backend=Manifold",
  "--render",
  "--colorscheme=Cornfield"
] as const;

/** The `--imgsize` baked into {@link RENDER_COMMON_FLAGS}, as numbers. */
export const DEFAULT_IMAGE_SIZE = [1024, 768] as const satisfies readonly [number, number];

/** The `--colorscheme` baked into {@link RENDER_COMMON_FLAGS}. */
export const DEFAULT_COLORSCHEME = "Cornfield";

/** The `--projection` baked into {@link RENDER_COMMON_FLAGS}. */
export const DEFAULT_PROJECTION = "ortho";

/** The geometry backend baked into {@link RENDER_COMMON_FLAGS}. */
export const DEFAULT_BACKEND = "Manifold";

/**
 * Per-invocation OpenSCAD subprocess timeout (SDP §7, enforced in Spike 2's
 * harness). Every external call is wrapped with a timeout + typed error
 * (PROJECT_CONTEXT.md "Error handling").
 */
export const DEFAULT_RENDER_TIMEOUT_MS = 60_000;

/**
 * The pinned OpenSCAD image, by digest (PROJECT_CONTEXT.md Spike Decisions /
 * CLAUDE.md "Pinned toolchain"). Immutable and reproducible — never resolve a
 * floating tag at runtime.
 */
export const OPENSCAD_IMAGE =
  "docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7";

/** `openscad --version` inside {@link OPENSCAD_IMAGE}. */
export const OPENSCAD_VERSION = "2026.01.19 (git e43242666)";

// ═════════════════════════════════════════════════════════════════════════════
// 3. Section view — the two-pass contract
// ═════════════════════════════════════════════════════════════════════════════

/** The axis the section half-space is cut along. */
export type SectionAxis = "x" | "y" | "z";

/** Intermediate mesh format used by the section view's first pass. */
export type SectionMeshFormat = "off" | "stl";

/**
 * SPIKE OVERRIDES SDP — the section view is a TWO-PASS render.
 *
 * SDP §6.2 sketches a single pass:
 * `difference(){ include <model.scad>; <half-space cube> }`.
 * **That does not parse.** OpenSCAD's grammar accepts `include`/`use` only at a
 * file's top level, never inside a `{}` scope, and the resulting parser error is
 * reported at a misleading location deep inside whatever file the include pulls
 * in next (Spike 2 §"Section view: a correction").
 *
 * The working contract:
 *   1. Render `model.scad` to an intermediate mesh (`-o <mesh>`), one process.
 *   2. Generate a wrapper that `import()`s that mesh and differences a
 *      half-space cube from it, then render the wrapper with the `section`
 *      camera, a second process.
 *
 * Works regardless of how the source `.scad` is structured (single root module
 * or bare top-level statements).
 */
export const SECTION_VIEW_CONTRACT = {
  passes: 2,
  /** Pass 1 exports this format; OFF is geometry-only and dependency-free to write. */
  meshFormat: "off",
  /** The section cut is taken along Y. */
  axis: "y",
  /**
   * The half-space that is REMOVED. Cutting the `-Y` half puts the cut face
   * toward the `front`/`section` camera; cutting `+Y` leaves the untouched
   * exterior facing the camera and is visually indistinguishable from an uncut
   * front view. Confirmed independently by Spike 2 (§"Section view") and
   * Spike 3 (§8).
   */
  removeHalf: "negative",
  /** The half-space cube's `translate([...])` vector, in mm. */
  cubeTranslate: [-1000, -2000, -1000],
  /** The half-space cube's `cube([...])` size, in mm. Large enough to bound any v1 part. */
  cubeSize: [2000, 2000, 2000]
} as const;

/**
 * The exact wrapper source generated for pass 2. `{{MESH}}` is replaced with
 * the pass-1 mesh path (as OpenSCAD `import()` sees it). Kept here so the
 * runner, the MCP server and any future WASM path emit identical geometry.
 */
export const SECTION_WRAPPER_TEMPLATE =
  'difference() {\n  import("{{MESH}}");\n  translate([-1000, -2000, -1000]) cube([2000, 2000, 2000]);\n}\n';

/** The token {@link SECTION_WRAPPER_TEMPLATE} substitutes the mesh path for. */
export const SECTION_WRAPPER_MESH_TOKEN = "{{MESH}}";

// ═════════════════════════════════════════════════════════════════════════════
// 4. Render request / result
// ═════════════════════════════════════════════════════════════════════════════

/** An axis-aligned bounding box, in mm. */
export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** Input to the OpenSCAD CLI runner's view render. */
export interface RenderRequest {
  /** Absolute path to the `.scad` file to render. */
  scadPath: string;
  /** Directory the runner writes PNGs (and any section intermediate) into. */
  outDir: string;
  /** Views to render. Defaults to {@link DEFAULT_VIEWS} when omitted. */
  views?: readonly ViewName[];
  /** Parameter overrides applied for this render only; not persisted. */
  params?: ParamValues;
  /** Overrides `--imgsize`. Defaults to {@link DEFAULT_IMAGE_SIZE}. */
  imgsize?: readonly [number, number];
  /** Defaults to {@link DEFAULT_RENDER_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** One rendered view. */
export interface RenderedView {
  view: ViewName;
  ok: boolean;
  /** Absolute path to the PNG; null when this view failed. */
  path: string | null;
  /** The `--camera=` value used — always {@link VIEW_CAMERA_ARGS}`[view]`. */
  camera: string;
  projection: "ortho" | "perspective";
  imgsize: readonly [number, number];
  bytes: number | null;
  render_ms: number;
  /**
   * Filtered OpenSCAD diagnostics: `ERROR:` / `WARNING:` / `TRACE:` lines only.
   * OpenSCAD prints ~10 lines of cache statistics on every invocation; passing
   * them through burns a few hundred tokens per render (Spike 3 §7.2).
   * `null`, never `""`, when there is nothing to report.
   */
  stderr: string | null;
}

/** Result of a view render. */
export interface RenderResult {
  /** True only when every requested view rendered. */
  ok: boolean;
  views: RenderedView[];
  /** Wall-clock ms across every invocation, including section pass 1. */
  total_ms: number;
  /** Set when `ok` is false. */
  error_code?: ScadForgeErrorCode;
  /** Set when `ok` is false. Human-readable and actionable. */
  message?: string;
}

/** Result of the `write_scad` syntax check (a parse-only OpenSCAD invocation). */
export interface SyntaxCheckResult {
  ok: boolean;
  /** `ERROR:` lines from OpenSCAD, one per entry. */
  errors: string[];
  /** `WARNING:` lines from OpenSCAD, one per entry. */
  warnings: string[];
  ms: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Mesh validation — Spike 4's merged proposal, verbatim
// ═════════════════════════════════════════════════════════════════════════════

/**
 * manifold-3d's `status()` values, plus one ScadForge-local value.
 *
 * Adopted verbatim from Spike 4 (docs/spikes/04-manifold-validate/README.md
 * §"Proposed `ValidationReport` type"). Note that the spike's raw CLI output
 * prints the *thrown message* `"Not manifold"` for the construction-failure
 * case; the contract's name for that case is `'ConstructionFailed'`.
 */
export type ManifoldStatus =
  | "NoError"
  | "NonFiniteVertex"
  | "NotManifold"
  | "VertexOutOfBounds"
  | "PropertiesWrongLength"
  | "MissingPositionProperties"
  | "MergeVectorsDifferentLengths"
  | "MergeIndexOutOfBounds"
  | "TransformWrongLength"
  | "RunIndexWrongLength"
  | "FaceIDWrongLength"
  | "InvalidConstruction"
  | "ResultTooLarge"
  | "InvalidTangents"
  | "Cancelled"
  // Not a manifold-3d status; set when Manifold construction throws outright
  // (e.g. the mesh is not an oriented 2-manifold at all) rather than
  // returning a queryable handle with a non-NoError status.
  | "ConstructionFailed";

/**
 * The result of loading an exported mesh into manifold-3d.
 *
 * FROZEN, verbatim from Spike 4's merged proposal. Deliberately excludes the
 * richer fields Spike 3's prototype reported (`watertight`, `boundary_edges`,
 * `non_manifold_edges`, `degenerate_triangles`): those came from hand-rolled
 * STL edge-pairing, which Spike 3 §8 itself found produced 16 spurious
 * non-manifold edges on a mesh OpenSCAD considers `Simple: yes`. manifold-3d's
 * `status()` replaces them.
 *
 * Pass/fail gating and warnings are NOT part of this report — see
 * {@link ValidationGateResult}.
 *
 * INPUT: a parallel binary-STL export (`--export-format=binstl`), NOT a 3MF
 * parse. `openscad -o out.3mf -o out.stl model.scad` runs ONE render and emits
 * both, so the STL costs nothing extra, needs zero dependencies, and keeps
 * `packages/scad-core` free of ~2.2MB of zip/XML parsing (Spike 4 §"INPUT
 * FORMAT DECISION"). STL triangle soup must be vertex-welded (epsilon 1e-5mm)
 * before it is handed to manifold-3d.
 */
export interface ValidationReport {
  /** True iff status === 'NoError' and the mesh is non-empty. */
  manifold: boolean;
  /** manifold-3d's status(), or 'ConstructionFailed' — see ManifoldStatus. */
  status: ManifoldStatus;
  /** null when manifold is false (no valid solid to measure). */
  volume_mm3: number | null;
  surface_area: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Raw input triangle count (present even when manifold is false). */
  triangle_count: number;
  /** Count of disconnected solid components (via decompose().length). null when manifold is false. */
  components: number | null;
  /**
   * Euler-characteristic-derived genus of the WHOLE mesh. Only meaningful
   * when components === 1 -- see README note above. null when manifold is
   * false or components > 1.
   */
  genus: number | null;
}

/** Which hard gate a validation failure came from. */
export type ValidationGateCode =
  /** `manifold !== true`. */
  | "NOT_MANIFOLD"
  /** `volume_mm3 <= minVolumeMm3` — a manifold mesh can still have ~0 volume. */
  | "DEGENERATE_VOLUME"
  /** `components !== 1` and `allowMultiPart` was not set. */
  | "MULTIPLE_COMPONENTS"
  /** The mesh could not be parsed or loaded at all. */
  | "MESH_UNREADABLE";

/** One failed hard gate. */
export interface ValidationFailure {
  code: ValidationGateCode;
  /** Human-readable and actionable; read by the agent as well as the user. */
  message: string;
}

/** Caller-supplied gate configuration. */
export interface ValidationGateOptions {
  /**
   * Allow `components > 1`. Some legitimate models are intentional multi-body
   * exports (assemblies with separate parts by design). When set, the
   * components gate downgrades to a warning and `genus` is not surfaced as a
   * hint, since it is meaningless for multi-component meshes.
   */
  allowMultiPart?: boolean;
  /** Overrides {@link VALIDATION_GATE_DEFAULTS}`.minVolumeMm3`. */
  minVolumeMm3?: number;
}

/**
 * FROZEN gate thresholds (Spike 4 §"Suggested thresholds").
 *
 * - `manifold === true` — hard gate. `export` refuses without an explicit
 *   override (CLAUDE.md hard rule 7).
 * - `volume_mm3 > 0.001` — hard gate; rejects degenerate/zero-volume solids
 *   produced by cancelling geometry.
 * - `components === 1` — hard gate by default, overridable via `allowMultiPart`.
 *   Spike 3 found this the single highest-signal defect detector across every
 *   run ("the handle isn't attached").
 * - `genus` — INFORMATIONAL ONLY, no gate. Surface nonzero genus in the UI as a
 *   "has holes/handles" hint, and only when `components === 1`.
 * - `bbox` — no absolute threshold; scale sanity-checking is a UX concern, not
 *   a gate.
 */
export const VALIDATION_GATE_DEFAULTS = {
  minVolumeMm3: 0.001,
  allowMultiPart: false
} as const satisfies Required<ValidationGateOptions>;

/** The gate decision layered on top of a {@link ValidationReport}. */
export interface ValidationGateResult {
  /** True when no hard gate failed. */
  ok: boolean;
  /** Traffic-light state for the UI status strip: green = ok and no warnings. */
  badge: ValidationBadge;
  /** Empty when `ok` is true. */
  failures: ValidationFailure[];
  /** Non-blocking notes (e.g. multi-part allowed by override, nonzero genus). */
  warnings: string[];
}

/** Input to the mesh validator. */
export interface ValidationRequest {
  /** Absolute path to the mesh to validate — a binary STL (see {@link ValidationReport}). */
  meshPath: string;
  options?: ValidationGateOptions;
}

/** What `validate_mesh` produces: the raw report plus the gate decision. */
export interface ValidationResult {
  report: ValidationReport;
  gate: ValidationGateResult;
  /** Wall-clock ms for the mesh export that produced `meshPath`, if measured. */
  export_ms: number | null;
  /** Wall-clock ms spent loading and querying the mesh. */
  validate_ms: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Export
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Mesh export formats.
 *
 * CANONICAL definition — mirrored by `@scadforge/protocol`; drift is guarded by
 * `types.test.ts`. `3mf` is the default: it is the only one of the three that
 * preserves `color()` (lib3mf 1.8.1 in the pinned image, verified in Spike 2
 * AC 3). STL and OFF are geometry-only.
 */
export const EXPORT_FORMATS = ["3mf", "stl", "off"] as const;

/** One of {@link EXPORT_FORMATS}. */
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The default export format offered in the UI (SDP §9). */
export const DEFAULT_EXPORT_FORMAT = "3mf" satisfies ExportFormat;

/**
 * The `--export-format` value passed to the CLI for each {@link ExportFormat}.
 *
 * `stl` maps to `binstl`: OpenSCAD's STL default is ASCII, and every STL
 * ScadForge produces (export *and* the `validate_mesh` input) must be binary
 * (Spike 4 §"Format ambiguity").
 */
export const OPENSCAD_EXPORT_FORMAT_FLAG = {
  "3mf": "3mf",
  stl: "binstl",
  off: "off"
} as const satisfies Record<ExportFormat, string>;

/** The `--export-format` value that dumps the Customizer parameter schema. */
export const OPENSCAD_PARAM_EXPORT_FORMAT = "param";

/**
 * Input to an export run.
 *
 * Named `ExportRun*` rather than `Export*` so it does not collide with
 * `@scadforge/protocol`'s REST `ExportRequest`/`ExportResponse` — `apps/server`
 * imports both packages in the same file.
 */
export interface ExportRunRequest {
  scadPath: string;
  outDir: string;
  format: ExportFormat;
  /** Parameter overrides for this export only; not persisted. */
  params?: ParamValues;
  /**
   * Bypass the validation gate. CLAUDE.md hard rule 7: `export` runs
   * `validate_mesh` first and refuses on failure unless this is explicitly set.
   */
  allowValidationFailure?: boolean;
  /** Defaults to {@link DEFAULT_RENDER_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Result of an export run. See {@link ExportRunRequest} for the naming. */
export interface ExportRunResult {
  ok: boolean;
  /** Absolute path to the written file; null when the export was refused or failed. */
  path: string | null;
  format: ExportFormat;
  bytes: number | null;
  export_ms: number;
  /** The gate decision that allowed or refused the export; null if not run. */
  validation: ValidationGateResult | null;
  /** True when a red badge was overridden via `allowValidationFailure`. */
  validation_overridden: boolean;
  /** Set when `ok` is false. */
  error_code?: ScadForgeErrorCode;
  /** Set when `ok` is false. */
  message?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Library lookup (BOSL2 / MCAD index)
// ═════════════════════════════════════════════════════════════════════════════

/** Libraries vendored into `packages/libs`. */
export const LIBRARY_NAMES = ["BOSL2", "MCAD"] as const;

/** One of {@link LIBRARY_NAMES}. */
export type LibraryName = (typeof LIBRARY_NAMES)[number];

/**
 * One entry of the pre-built BOSL2/MCAD reference index.
 *
 * SDP §6.3: the index exists so BOSL2 docs are never stuffed into the system
 * prompt — the agent looks up signatures on demand instead.
 */
export interface LibrarySymbol {
  library: LibraryName;
  /** Symbol name, e.g. `screw_hole`. */
  name: string;
  kind: "module" | "function" | "constant";
  /** Full signature line, e.g. `screw_hole(spec, head, thread, ...)`. */
  signature: string;
  /** Path of the defining `.scad` file, relative to the library root. */
  file: string;
  /** One- or two-line description drawn from the library's own doc comments. */
  summary: string;
  /** Short usage snippets. Never a whole file. */
  examples: string[];
  /** The `include <...>` / `use <...>` line required to call this symbol. */
  include: string;
}
