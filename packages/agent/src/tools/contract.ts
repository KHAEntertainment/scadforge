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
// The seven agent tools, shared verbatim between the Claude Agent SDK provider
// (`packages/agent`) and the stdio MCP server (`packages/mcp-server`).
//
// Input schemas are declared as **zod v4 RAW SHAPES** — plain objects of zod
// validators — because that is exactly what the SDK's
// `tool(name, description, zodRawShape, handler)` takes (Spike 3 §6). The same
// shape is wrapped with `z.object()` for parsing, and converted with
// `z.toJSONSchema()` for any consumer that needs JSON Schema (the MCP wire
// format, or a future `VercelAiSdkProvider`). Declaring the shape once and
// deriving both directions is what keeps the two runtimes from drifting.
//
// Nothing in this file executes a tool. Handlers live in Issue #16.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { EDITOR_LABEL_MAX_CODE_POINTS, ERROR_CODES, VIEW_NAMES } from "@scadforge/protocol";
import type {
  AgentEditorContext,
  EditorSidecarStatus,
  ScadForgeErrorCode,
  ToolName as ProtocolToolName
} from "@scadforge/protocol";
import { EXPORT_FORMATS, LIBRARY_NAMES } from "@scadforge/scad-core";
import type {
  ManifoldStatus,
  ParamSchema,
  ValidationGateResult,
  ValidationReport
} from "@scadforge/scad-core";

// ═════════════════════════════════════════════════════════════════════════════
// 1. Tool identity
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The seven tools (PROJECT_CONTEXT.md "Agent tools", SDP §6.2).
 *
 * CANONICAL definition — `@scadforge/protocol` mirrors this as `TOOL_NAMES`
 * because it has zero dependencies and cannot import from here. Drift is
 * guarded by `contract.test.ts`.
 */
export const TOOL_NAMES = [
  "read_project",
  "write_scad",
  "set_params",
  "render_views",
  "validate_mesh",
  "export",
  "library_lookup"
] as const;

/** One of {@link TOOL_NAMES}. */
export type ToolName = (typeof TOOL_NAMES)[number];

/** The MCP server name both runtimes register these tools under. */
export const MCP_SERVER_NAME = "scadforge";

/**
 * The prefix the Claude Agent SDK exposes MCP tools to the model under:
 * `mcp__<serverName>__<toolName>`.
 *
 * Spike 3 §6: this prefix is a Claude-Code artifact. It is added and stripped
 * inside the provider, and must NEVER appear in a `tool_call` / `tool_result`
 * SSE event or anywhere in `@scadforge/protocol`.
 */
export const MCP_TOOL_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * One-line tool descriptions, shown to the model. Kept short deliberately: they
 * are resident in every request's system prompt, and cache-read volume — not
 * output — dominates turn cost (Spike 3 §5).
 */
export const TOOL_DESCRIPTIONS = {
  read_project:
    "Read the current project: model.scad contents, params.json values, the Customizer parameter schema, and the most recent validation report.",
  write_scad:
    "Replace model.scad with a complete new file (whole-file writes only in v1), syntax-check it, and create a snapshot. Consumes one pass of the per-turn budget.",
  set_params:
    "Update named Customizer parameter values in params.json without touching model.scad.",
  render_views:
    "Render the model from the fixed camera views and return the PNGs as images. Inspect them before declaring the model done.",
  validate_mesh:
    "Export the mesh and check it with manifold-3d: manifoldness, volume, surface area, bounding box, triangle count, connected components, genus. Treat failures as blocking.",
  export:
    "Export the model to 3MF, STL or OFF. Runs validate_mesh first and refuses on failure unless explicitly overridden.",
  library_lookup:
    "Search the bundled BOSL2/MCAD reference index for module and function signatures with usage examples."
} as const satisfies Record<ToolName, string>;

// ═════════════════════════════════════════════════════════════════════════════
// 2. Shared zod primitives
// ═════════════════════════════════════════════════════════════════════════════

/** A single Customizer parameter value (mirrors scad-core's `ParamValue`). */
export const paramValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(z.number()),
  z.array(z.string()),
  z.array(z.boolean())
]);

/** A `{name: value}` bag of Customizer parameter values. */
export const paramValuesSchema = z.record(z.string(), paramValueSchema);

/** The five fixed views, derived from `@scadforge/protocol`'s `VIEW_NAMES`. */
export const viewNameSchema = z.enum(VIEW_NAMES);

/** The three mesh export formats, derived from scad-core's `EXPORT_FORMATS`. */
export const exportFormatSchema = z.enum(EXPORT_FORMATS);

/** The vendored libraries, derived from scad-core's `LIBRARY_NAMES`. */
export const libraryNameSchema = z.enum(LIBRARY_NAMES);

/** The closed error-code union, derived from `@scadforge/protocol`'s `ERROR_CODES`. */
export const errorCodeSchema = z.enum(ERROR_CODES);

// ── zod mirrors of scad-core's CAD domain types ──────────────────────────────
//
// scad-core owns these as TYPES; tool results need them as runtime SCHEMAS so
// `packages/mcp-server` can validate a payload it did not construct. Rather
// than falling back to `z.unknown()`, each schema below is pinned to its
// scad-core counterpart by a `MutuallyAssignable` guard in section 7 — a field
// added, removed or retyped on either side fails `tsc`.

/**
 * manifold-3d's status values plus ScadForge's `ConstructionFailed`.
 *
 * scad-core defines `ManifoldStatus` as a bare union type (verbatim from
 * Spike 4's merged proposal), so there is no runtime array to derive from.
 * This list is pinned to it by {@link ManifoldStatusMirrorCheck}.
 */
export const MANIFOLD_STATUSES = [
  "NoError",
  "NonFiniteVertex",
  "NotManifold",
  "VertexOutOfBounds",
  "PropertiesWrongLength",
  "MissingPositionProperties",
  "MergeVectorsDifferentLengths",
  "MergeIndexOutOfBounds",
  "TransformWrongLength",
  "RunIndexWrongLength",
  "FaceIDWrongLength",
  "InvalidConstruction",
  "ResultTooLarge",
  "InvalidTangents",
  "Cancelled",
  "ConstructionFailed"
] as const;

/** Mirrors scad-core's `ManifoldStatus`. */
export const manifoldStatusSchema = z.enum(MANIFOLD_STATUSES);

/** Mirrors scad-core's `ParamType`. */
export const paramTypeSchema = z.enum(["number", "boolean", "string", "vector"]);

/** Mirrors scad-core's `ParamOption`. */
export const paramOptionSchema = z.object({
  name: z.string(),
  value: paramValueSchema
});

/**
 * Mirrors scad-core's `ParamDefinition` — one entry of OpenSCAD's
 * `--export-format=param` output. Field names are OpenSCAD's, not camelCased.
 */
export const paramDefinitionSchema = z.object({
  name: z.string(),
  type: paramTypeSchema,
  initial: paramValueSchema,
  caption: z.string().optional(),
  group: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  maxLength: z.number().optional(),
  options: z.array(paramOptionSchema).optional()
});

/** Mirrors scad-core's `ParamSchema` — the full `--export-format=param` document. */
export const paramSchemaSchema = z.object({
  title: z.string(),
  parameters: z.array(paramDefinitionSchema)
});

/** Mirrors scad-core's `ValidationBadge` (canonically `@scadforge/protocol`'s). */
export const validationBadgeSchema = z.enum(["green", "amber", "red"]);

/** Mirrors scad-core's `ValidationGateCode`. */
export const validationGateCodeSchema = z.enum([
  "NOT_MANIFOLD",
  "DEGENERATE_VOLUME",
  "MULTIPLE_COMPONENTS",
  "MESH_UNREADABLE"
]);

/** Mirrors scad-core's `ValidationFailure`. */
export const validationFailureSchema = z.object({
  code: validationGateCodeSchema,
  message: z.string()
});

/**
 * Mirrors scad-core's `ValidationGateResult` — the pass/fail decision layered
 * on top of a `ValidationReport`.
 *
 * This is the ONE gate shape across all three frozen surfaces: scad-core's
 * `ValidationResult.gate` and `ExportRunResult.validation`, and — via this
 * schema — both `validate_mesh`'s `gate` and `export`'s `validation` tool
 * payloads. `export` must be able to tell the agent WHICH gate refused it, not
 * just that something did (SDP §6.2: `export` returns a "validation summary").
 */
export const validationGateResultSchema = z.object({
  ok: z.boolean(),
  badge: validationBadgeSchema,
  failures: z.array(validationFailureSchema),
  warnings: z.array(z.string())
});

/** Mirrors scad-core's `ValidationReport` — Spike 4's merged proposal. */
export const validationReportSchema = z.object({
  manifold: z.boolean(),
  status: manifoldStatusSchema,
  volume_mm3: z.number().nullable(),
  surface_area: z.number().nullable(),
  bbox: z
    .object({
      min: z.tuple([z.number(), z.number(), z.number()]),
      max: z.tuple([z.number(), z.number(), z.number()])
    })
    .nullable(),
  triangle_count: z.number().int().min(0),
  components: z.number().int().min(0).nullable(),
  genus: z.number().int().nullable()
});

// ── zod mirror of @scadforge/protocol's `AgentEditorContext` (S3-A, Issue #68)
//
// Referenceability only — the `editor` block on `read_project` is what lets the
// agent cite features by `featureId` rather than by ordinal or label. It is NOT
// proof of edit authority; the shared invalidation boundary continues to
// invalidate the active editor document on every agent write. Mirrored with
// the same field-set, sidecar-status enum, and version constraint as the REST
// surface so a guard in section 7 proves the inferred type matches
// `AgentEditorContext`. Runtime validation against the wire is enforced by
// `@scadforge/protocol`'s `parseAgentEditorContext`; this schema mirrors the
// frozen shape for the agent runtime boundary.

/** UUID v4 string. Matches `@scadforge/protocol`'s editor-sidecar validator. */
const editorUuidSchema = z.string().uuid();

/** Lowercase 64-hex digest. SHA-256 family — canonical JSON encoding. */
const editorHex64Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be lowercase 64-hex");

/** `EditorSidecarStatus` — typed enum (S3-C §10.2 Q3 owner decision). */
export const editorSidecarStatusSchema: z.ZodType<EditorSidecarStatus> = z.enum([
  "ready",
  "legacy-empty",
  "missing",
  "corrupt",
  "unsupported-version"
]);

/** Mirrors `EditorFeature` from `@scadforge/protocol`. */
export const editorFeatureSchema = z
  .object({
    featureId: editorUuidSchema,
    /**
     * Labels are limited to {@link EDITOR_LABEL_MAX_CODE_POINTS} Unicode code
     * points per the wire-and-recovery spec. We count code points via
     * `[...s].length`, NOT UTF-16 units, so a 120-emoji label (240 UTF-16
     * units) is accepted — matches `@scadforge/protocol`'s `expectLabel`.
     */
    label: z
      .string()
      .min(1)
      .refine(
        (s) => [...s].length <= EDITOR_LABEL_MAX_CODE_POINTS,
        `label must be at most ${EDITOR_LABEL_MAX_CODE_POINTS} Unicode code points`
      ),
    projectId: editorUuidSchema,
    createdAtRevision: editorHex64Schema,
    sourceFingerprint: editorHex64Schema,
    bindingVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    provenance: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("manual") }).strict(),
      z
        .object({
          kind: z.enum(["ai-proposed", "parser-proposed"]),
          confirmedBy: z.literal("user")
        })
        .strict()
    ]),
    binding: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("linear"),
          parameter: z.string().min(1),
          axis: z.enum(["x", "y", "z"]),
          mapping: z
            .object({
              scale: z.union([z.literal(1), z.literal(2)]),
              offset: z.number().finite(),
              anchor: z.enum(["min", "max", "center"])
            })
            .strict()
        })
        .strict(),
      z
        .object({
          kind: z.literal("radial"),
          parameter: z.string().min(1),
          center: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
          axis: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
          parameterMeaning: z.enum(["radius", "diameter"]),
          presentation: z.enum(["radius", "diameter"])
        })
        .strict()
    ])
  })
  .strict();

/** Mirrors `EditorEligibility` from `@scadforge/protocol`. */
export const editorEligibilitySchema = z
  .object({
    featureId: editorUuidSchema,
    state: z.enum(["requires-proof", "unsupported"]),
    reason: z.string().nullable()
  })
  .strict();

/**
 * Mirrors `AgentEditorContext` from `@scadforge/protocol`.
 *
 * Per wire-and-recovery §"D7 agent referenceability":
 * "The mirrored runtime schema is exact, using the same sidecar/feature/
 * eligibility validation and version constraints as REST; guards must prove
 * its inferred type matches AgentEditorContext."
 *
 * Drift is detected by `AgentEditorContextMirrorCheck` in section 7.
 */
export const agentEditorContextSchema = z
  .object({
    version: z.literal(1),
    projectId: editorUuidSchema,
    editorRevision: editorHex64Schema,
    sourceRevision: editorHex64Schema,
    sourceFingerprint: editorHex64Schema,
    sidecarStatus: editorSidecarStatusSchema,
    features: z.array(editorFeatureSchema).max(256),
    eligibility: z.array(editorEligibilitySchema).max(256)
  })
  .strict();

// ═════════════════════════════════════════════════════════════════════════════
// 3. Tool input raw shapes
//
// Each tool exports its raw shape (`*InputShape`, for `tool()`) and the wrapped
// object schema (`*InputSchema`, for parsing and JSON-Schema derivation).
// ═════════════════════════════════════════════════════════════════════════════

/** `read_project` takes no input (SDP §6.2). */
export const readProjectInputShape = {} as const;
export const readProjectInputSchema = z.object(readProjectInputShape);
export type ReadProjectInput = z.infer<typeof readProjectInputSchema>;

/**
 * `write_scad` — v1 is whole-file writes only; diff-edits are a v2 concern
 * (SDP §6.2).
 */
export const writeScadInputShape = {
  /** The complete new contents of `model.scad`. Never a fragment or a diff. */
  content: z
    .string()
    .min(1)
    .describe("Complete new contents of model.scad. Whole-file write; never a fragment or a diff."),
  /**
   * The snapshot message. Short summary only — CLAUDE.md hard rule 5 forbids
   * pasting `.scad` into chat, and this string reaches the chat transcript.
   */
  message: z
    .string()
    .min(1)
    .max(200)
    .describe("One-line summary of what changed, for the snapshot and the chat transcript. Never include OpenSCAD code.")
} as const;
export const writeScadInputSchema = z.object(writeScadInputShape);
export type WriteScadInput = z.infer<typeof writeScadInputSchema>;

/** `set_params` — update named parameter values only. */
export const setParamsInputShape = {
  params: paramValuesSchema.describe("Parameter values to set, keyed by the OpenSCAD variable name. Only the named parameters change.")
} as const;
export const setParamsInputSchema = z.object(setParamsInputShape);
export type SetParamsInput = z.infer<typeof setParamsInputSchema>;

/** `render_views` — every field optional; defaults come from scad-core. */
export const renderViewsInputShape = {
  views: z
    .array(viewNameSchema)
    .min(1)
    .optional()
    .describe("Views to render. Defaults to iso, front, right, section. 'top' is near-useless on flat-topped parts."),
  imgsize: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .optional()
    .describe("Image size in pixels as [width, height]. Defaults to [1024, 768]."),
  params: paramValuesSchema.optional().describe("Parameter overrides for this render only; not persisted.")
} as const;
export const renderViewsInputSchema = z.object(renderViewsInputShape);
export type RenderViewsInput = z.infer<typeof renderViewsInputSchema>;

/** `validate_mesh` — every field optional. */
export const validateMeshInputShape = {
  params: paramValuesSchema.optional().describe("Parameter overrides for this validation only; not persisted."),
  allowMultiPart: z
    .boolean()
    .optional()
    .describe("Allow a mesh with more than one disconnected solid component. Only set this when separate pieces were explicitly requested.")
} as const;
export const validateMeshInputSchema = z.object(validateMeshInputShape);
export type ValidateMeshInput = z.infer<typeof validateMeshInputSchema>;

/** `export` — `format` required; validation gate overridable. */
export const exportInputShape = {
  format: exportFormatSchema.describe("Mesh export format. 3MF is the only one that preserves colors."),
  params: paramValuesSchema.optional().describe("Parameter overrides for this export only; not persisted."),
  allowValidationFailure: z
    .boolean()
    .optional()
    .describe("Export even though validation failed. Requires the user to have explicitly asked for the override.")
} as const;
export const exportInputSchema = z.object(exportInputShape);
export type ExportInput = z.infer<typeof exportInputSchema>;

/** `library_lookup` — query the pre-built BOSL2/MCAD index. */
export const libraryLookupInputShape = {
  query: z.string().min(1).describe("Free-text query, e.g. 'BOSL2 screw_hole' or 'rounded cuboid'."),
  library: libraryNameSchema.optional().describe("Restrict the search to one library."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of matches to return. Defaults to 5.")
} as const;
export const libraryLookupInputSchema = z.object(libraryLookupInputShape);
export type LibraryLookupInput = z.infer<typeof libraryLookupInputSchema>;

/**
 * Every tool's raw shape, keyed by tool name. This is the object a provider
 * iterates to register all seven tools.
 */
export const TOOL_INPUT_SHAPES = {
  read_project: readProjectInputShape,
  write_scad: writeScadInputShape,
  set_params: setParamsInputShape,
  render_views: renderViewsInputShape,
  validate_mesh: validateMeshInputShape,
  export: exportInputShape,
  library_lookup: libraryLookupInputShape
} as const;

/** Every tool's wrapped object schema, keyed by tool name. */
export const TOOL_INPUT_SCHEMAS = {
  read_project: readProjectInputSchema,
  write_scad: writeScadInputSchema,
  set_params: setParamsInputSchema,
  render_views: renderViewsInputSchema,
  validate_mesh: validateMeshInputSchema,
  export: exportInputSchema,
  library_lookup: libraryLookupInputSchema
} as const;

/** The parsed input type of a given tool. */
export type ToolInput<T extends ToolName> = z.infer<(typeof TOOL_INPUT_SCHEMAS)[T]>;

// ═════════════════════════════════════════════════════════════════════════════
// 4. Tool result envelope (Spike 3 §7.1)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The success envelope. `content[0]` of every tool result is a SINGLE `text`
 * block containing this JSON and nothing else — no prose, no markdown fence.
 * Tool-specific fields are merged in alongside `ok` and `pass`.
 */
export const toolSuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  /** The self-correction pass this call belongs to. 0 = the initial plan pass. */
  pass: z.number().int().min(0)
});

/**
 * The failure envelope. `error_code` is `SCREAMING_SNAKE_CASE` and is the SAME
 * vocabulary as the REST `{error_code, message}` body, so a code flows
 * tool → SSE → HTTP with no translation (Spike 3 §7.1).
 *
 * A failure is signalled HERE, in the JSON — not with `isError: true`. See
 * {@link TOOL_RESULT_RULES}.
 */
export const toolFailureEnvelopeSchema = z.object({
  ok: z.literal(false),
  error_code: errorCodeSchema,
  message: z.string().min(1)
});

/** Either envelope. */
export const toolEnvelopeSchema = z.union([toolSuccessEnvelopeSchema, toolFailureEnvelopeSchema]);

/** Failure payload as a TypeScript type. */
export interface ToolFailurePayload {
  ok: false;
  error_code: ScadForgeErrorCode;
  message: string;
}

// ── content blocks ───────────────────────────────────────────────────────────

/** A text block in an MCP `CallToolResult`. */
export interface ToolTextBlock {
  type: "text";
  text: string;
}

/**
 * An image block in an MCP `CallToolResult`.
 *
 * Spike 3 §3 verified this shape end-to-end: the model demonstrably reads the
 * pixels (it recovered 4/4 characters of a random code that was only ever
 * modelled in geometry, and correctly answered "no characters visible" when a
 * camera preset genuinely hid them).
 *
 * `data` is BARE base64 — no `data:` URI prefix. Multiple image blocks in one
 * result work; no cap was reached at 12 images across a 3-response run.
 */
export interface ToolImageBlock {
  type: "image";
  /** Bare base64. NO `data:image/png;base64,` prefix. */
  data: string;
  mimeType: typeof TOOL_RESULT_IMAGE_MIME_TYPE;
}

/** A block of an MCP `CallToolResult`. */
export type ToolContentBlock = ToolTextBlock | ToolImageBlock;

/**
 * The MCP `CallToolResult` both runtimes return.
 *
 * `isError` is typed `false | undefined` ON PURPOSE — see
 * {@link TOOL_RESULT_RULES}: an `isError: true` result cannot carry images,
 * because the SDK collapses `content` to a plain string and every image block
 * is silently dropped. ScadForge tools signal failure with `ok: false` inside
 * `content[0]`'s JSON instead, which keeps the render that explains the failure
 * attached to the result.
 */
export interface ToolCallResult {
  content: ToolContentBlock[];
  isError?: false;
}

/** The only image MIME type tool results carry. */
export const TOOL_RESULT_IMAGE_MIME_TYPE = "image/png";

/**
 * The text prefix of the label block that MUST immediately precede each image
 * block. Spike 3 §3: emitting `{type:'text', text:'view: iso'}` before the
 * image is enough for the model to bind view names to pictures — it referred to
 * "the section view" and "the iso view" correctly and unprompted.
 */
export const IMAGE_LABEL_PREFIX = "view: ";

/**
 * The tool-result payload conventions, frozen from Spike 3 §7.2. Stated as data
 * so a lint/test can assert against them and so `packages/mcp-server` inherits
 * the same rules as the SDK provider.
 */
export const TOOL_RESULT_RULES = {
  /**
   * `content[0]` is a single `text` block holding pure JSON — the envelope
   * plus tool-specific fields. No prose, no markdown fence, nothing else in
   * that block.
   */
  jsonFirstBlock: true,
  /**
   * NEVER set `isError: true` on a result that carries images. The SDK
   * collapses an error result's `content` to a plain string and the images are
   * lost. Render failures return a normal (non-error) result whose JSON says
   * `ok: false` and whose `stderr` explains why — with any partial renders
   * still attached.
   */
  neverIsErrorWithImages: true,
  /**
   * Emit `{type:'text', text:'view: <name>'}` immediately BEFORE each image
   * block. Order is preserved end-to-end.
   */
  labelBeforeEachImage: true,
  /**
   * Host code reading tool results must handle `content` being an array OR a
   * string — the SDK collapses it on error results.
   */
  contentMayBeArrayOrString: true,
  /**
   * Filter subprocess stderr to `ERROR:` / `WARNING:` / `TRACE:` lines.
   * OpenSCAD prints ~10 lines of cache statistics per invocation; passing them
   * through burns a few hundred tokens on every render. Return `null`, never
   * `""`, when there is nothing to report.
   */
  filterStderr: true,
  /**
   * `write_scad` always echoes `pass`, `max_passes` and `passes_remaining` so
   * the model self-paces instead of discovering the cap by hitting it.
   */
  echoBudgetState: true
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// 5. Tool result payload schemas (Spike 3 §7.3, validated by working code)
// ═════════════════════════════════════════════════════════════════════════════

/** The syntax-check block `write_scad` returns. */
export const syntaxCheckSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  ms: z.number()
});

/**
 * `read_project` result payload (SDP §6.2: "`model.scad`, `params.json`,
 * current param schema, last validation").
 *
 * `param_schema` and `validation` are the real mirrored schemas, NOT
 * `z.unknown()` escape hatches — both are pinned to their scad-core
 * counterparts by the guards in section 7.
 *
 * The optional `editor` block (S3-A, Issue #68) carries the D7
 * referenceability surface: features, eligibility, and current `sidecarStatus`
 * for the project. Omitted by legacy adapters that do not implement editor
 * context — never construed as an empty confirmed document.
 */
export const readProjectResultSchema = toolSuccessEnvelopeSchema.extend({
  scad: z.string(),
  params: paramValuesSchema,
  /** The Customizer parameter schema from `--export-format=param`. */
  param_schema: paramSchemaSchema,
  /** The most recent `ValidationReport`, or null if the model has never been validated. */
  validation: validationReportSchema.nullable(),
  head_snapshot: z.string().nullable(),
  /**
   * S3-A (Issue #68) editor referenceability block. Mirrors
   * {@link agentEditorContextSchema} verbatim when present. Omission is
   * allowed only for legacy adapters; modern `read_project` returns the block
   * for every readable project (wire-and-recovery §"D7 agent
   * referenceability").
   */
  editor: agentEditorContextSchema.optional()
});

/** `write_scad` result payload. Always echoes budget state. */
export const writeScadResultSchema = toolSuccessEnvelopeSchema.extend({
  max_passes: z.number().int().min(0),
  passes_remaining: z.number().int().min(0),
  bytes: z.number().int().min(0),
  snapshot: z.string().nullable(),
  syntax_check: syntaxCheckSchema
});

/** `set_params` result payload. */
export const setParamsResultSchema = toolSuccessEnvelopeSchema.extend({
  params: paramValuesSchema,
  /** Names that were rejected because they are not in the parameter schema. */
  unknown_params: z.array(z.string()),
  snapshot: z.string().nullable()
});

/** One entry of `render_views`'s `views` array. */
export const renderedViewSchema = z.object({
  view: viewNameSchema,
  ok: z.boolean(),
  camera: z.string(),
  projection: z.enum(["ortho", "perspective"]),
  imgsize: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  bytes: z.number().int().min(0).nullable(),
  render_ms: z.number(),
  /** Filtered diagnostics; `null`, never `""`, when there is nothing to report. */
  stderr: z.string().nullable()
});

/**
 * `render_views` result payload. The (label, image) block pairs follow in the
 * SAME order as this array.
 *
 * `ok` may be `false` here while the result still carries images — that is the
 * whole point of {@link TOOL_RESULT_RULES}`.neverIsErrorWithImages`.
 */
export const renderViewsResultSchema = z.object({
  ok: z.boolean(),
  pass: z.number().int().min(0),
  views: z.array(renderedViewSchema),
  total_ms: z.number(),
  note: z.string().optional(),
  error_code: errorCodeSchema.optional(),
  message: z.string().optional()
});

/**
 * `validate_mesh` result payload: the frozen report plus the gate decision.
 *
 * Shape matches scad-core's `ValidationResult` (`{report, gate, export_ms,
 * validate_ms}`) with the tool envelope's `ok`/`pass` on top. `gate` is the
 * SAME {@link validationGateResultSchema} that `export` returns as
 * `validation`, so the agent reads one gate shape from both tools.
 */
export const validateMeshResultSchema = z.object({
  ok: z.boolean(),
  pass: z.number().int().min(0),
  report: validationReportSchema,
  gate: validationGateResultSchema,
  export_ms: z.number().nullable(),
  validate_ms: z.number()
});

/**
 * `export` result payload.
 *
 * SDP §6.2 promises `export` returns "file path, size, **validation summary**",
 * and both other frozen surfaces model that summary for the same operation —
 * scad-core's `ExportRunResult.validation` and protocol's
 * `ExportResponse.validation`. `validation` here carries the full
 * {@link validationGateResultSchema}, so a refused export tells the agent WHICH
 * gate failed and with what warnings, not merely that something did.
 *
 * `validation` is `null` only when the gate could not run at all (e.g. the mesh
 * export itself failed, so there was nothing to validate). A refusal always
 * carries a populated gate plus `error_code: "VALIDATION_FAILED"`.
 * `validation_overridden` stays a separate boolean: it records that a red gate
 * was deliberately bypassed (CLAUDE.md hard rule 7), which the gate result
 * itself cannot express.
 */
export const exportResultSchema = z.object({
  ok: z.boolean(),
  pass: z.number().int().min(0),
  format: exportFormatSchema,
  /** Path relative to `.scadforge/exports/`; null when the export was refused. */
  file: z.string().nullable(),
  bytes: z.number().int().min(0).nullable(),
  export_ms: z.number(),
  /** The gate decision that allowed or refused this export; null if it could not run. */
  validation: validationGateResultSchema.nullable(),
  validation_overridden: z.boolean(),
  error_code: errorCodeSchema.optional(),
  message: z.string().optional()
});

/** One match from the BOSL2/MCAD index. */
export const librarySymbolSchema = z.object({
  library: libraryNameSchema,
  name: z.string(),
  kind: z.enum(["module", "function", "constant"]),
  signature: z.string(),
  file: z.string(),
  summary: z.string(),
  examples: z.array(z.string()),
  include: z.string()
});

/** `library_lookup` result payload. */
export const libraryLookupResultSchema = toolSuccessEnvelopeSchema.extend({
  query: z.string(),
  matches: z.array(librarySymbolSchema)
});

/** Every tool's result payload schema, keyed by tool name. */
export const TOOL_RESULT_SCHEMAS = {
  read_project: readProjectResultSchema,
  write_scad: writeScadResultSchema,
  set_params: setParamsResultSchema,
  render_views: renderViewsResultSchema,
  validate_mesh: validateMeshResultSchema,
  export: exportResultSchema,
  library_lookup: libraryLookupResultSchema
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// 6. Pass budget
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Environment variable holding the per-turn autonomous self-correction cap
 * (CLAUDE.md hard rule 4).
 */
export const MAX_PASSES_ENV_VAR = "SCADFORGE_MAX_PASSES";

/** Default per-turn pass budget. */
export const DEFAULT_MAX_PASSES = 2;

/**
 * The budget is enforced INSIDE the `write_scad` handler, which returns
 * `{ok:false, error_code:'PASS_BUDGET_EXHAUSTED'}` once the cap is reached —
 * NOT via the SDK's `maxTurns`.
 *
 * Spike 3 §6 amendment 3: `maxTurns` counts API round trips, not build passes,
 * and a turn that renders twice is not a second pass. Keeping the counter in
 * the tool layer also means `packages/mcp-server` inherits identical behaviour
 * for free. Confirmed effective across opus, sonnet and haiku.
 */
export const PASS_BUDGET_ENFORCEMENT = "write_scad_handler" as const;

// ═════════════════════════════════════════════════════════════════════════════
// 7. Compile-time guards
// ═════════════════════════════════════════════════════════════════════════════

/** True only when `A` and `B` are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails compilation if this file's `ToolName` and protocol's mirror diverge. */
export type ToolNameMirrorCheck = MutuallyAssignable<ToolName, ProtocolToolName>;

/**
 * Fail compilation if a zod mirror drifts from the scad-core type it mirrors —
 * a field added, removed, renamed or retyped on either side flips these to
 * `false`, and `contract.test.ts` assigns `true` to each. This is what lets the
 * result schemas above use real shapes instead of `z.unknown()` escape hatches
 * without protocol/scad-core and this file silently diverging.
 */
export type ManifoldStatusMirrorCheck = MutuallyAssignable<
  z.infer<typeof manifoldStatusSchema>,
  ManifoldStatus
>;

/** @see ManifoldStatusMirrorCheck */
export type ValidationReportMirrorCheck = MutuallyAssignable<
  z.infer<typeof validationReportSchema>,
  ValidationReport
>;

/** @see ManifoldStatusMirrorCheck */
export type ValidationGateResultMirrorCheck = MutuallyAssignable<
  z.infer<typeof validationGateResultSchema>,
  ValidationGateResult
>;

/** @see ManifoldStatusMirrorCheck */
export type ParamSchemaMirrorCheck = MutuallyAssignable<z.infer<typeof paramSchemaSchema>, ParamSchema>;

/**
 * Fails compilation if `agentEditorContextSchema` drifts from
 * `@scadforge/protocol`'s `AgentEditorContext` — wire-and-recovery §"D7 agent
 * referenceability" mandates the mirror is "exact". A field added, removed,
 * renamed or retyped on either side flips this to `false`, so `tsc` blocks
 * the change.
 */
export type AgentEditorContextMirrorCheck = MutuallyAssignable<
  z.infer<typeof agentEditorContextSchema>,
  AgentEditorContext
>;

/**
 * Re-exported so `validate_mesh` handlers and MCP consumers get the frozen
 * report type without reaching past this contract file.
 */
export type { ValidationReport };
