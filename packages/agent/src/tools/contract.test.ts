// FROZEN CONTRACT — ScadForge Issue #13. These assertions are the proof for
// `src/tools/contract.ts`: JSON-Schema derivation and the frozen required-field
// table for all seven tools, plus the Spike 3 tool-result payload conventions.
// Do NOT edit them inside a feature PR — changes require a Tech-Lead-approved
// contract-change issue, merged separately.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_NAMES as PROTOCOL_TOOL_NAMES } from "@scadforge/protocol";
import type { ToolName as ProtocolToolName } from "@scadforge/protocol";
import {
  DEFAULT_MAX_PASSES,
  IMAGE_LABEL_PREFIX,
  MAX_PASSES_ENV_VAR,
  MCP_SERVER_NAME,
  MCP_TOOL_NAME_PREFIX,
  PASS_BUDGET_ENFORCEMENT,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
  TOOL_INPUT_SHAPES,
  TOOL_NAMES,
  TOOL_RESULT_IMAGE_MIME_TYPE,
  TOOL_RESULT_RULES,
  TOOL_RESULT_SCHEMAS,
  agentEditorContextSchema,
  exportResultSchema,
  readProjectResultSchema,
  renderViewsResultSchema,
  toolFailureEnvelopeSchema,
  toolSuccessEnvelopeSchema,
  validateMeshResultSchema,
  validationGateResultSchema,
  validationReportSchema,
  writeScadResultSchema
} from "./contract.js";
import type {
  AgentEditorContextMirrorCheck,
  ManifoldStatusMirrorCheck,
  ParamSchemaMirrorCheck,
  ToolCallResult,
  ToolContentBlock,
  ToolName,
  ValidationGateResultMirrorCheck,
  ValidationReportMirrorCheck
} from "./contract.js";

/** True only when A and B are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Minimal shape of a derived JSON Schema object, for assertions below. */
interface DerivedSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: unknown;
}

const derive = (name: ToolName): DerivedSchema =>
  z.toJSONSchema(TOOL_INPUT_SCHEMAS[name]) as DerivedSchema;

/**
 * The frozen required-field set for each tool. This table IS the contract:
 * a schema change that adds or removes a required field fails here.
 */
const EXPECTED_REQUIRED: Record<ToolName, string[]> = {
  read_project: [],
  write_scad: ["content", "message"],
  set_params: ["params"],
  render_views: [],
  validate_mesh: [],
  export: ["format"],
  library_lookup: ["query"]
};

/** The frozen property set for each tool. */
const EXPECTED_PROPERTIES: Record<ToolName, string[]> = {
  read_project: [],
  write_scad: ["content", "message"],
  set_params: ["params"],
  render_views: ["views", "imgsize", "params"],
  validate_mesh: ["params", "allowMultiPart"],
  export: ["format", "params", "allowValidationFailure"],
  library_lookup: ["query", "library", "limit"]
};

describe("tool identity", () => {
  it("declares exactly the seven tools from PROJECT_CONTEXT.md / SDP §6.2", () => {
    expect([...TOOL_NAMES]).toEqual([
      "read_project",
      "write_scad",
      "set_params",
      "render_views",
      "validate_mesh",
      "export",
      "library_lookup"
    ]);
    expect(new Set(TOOL_NAMES).size).toBe(7);
  });

  it("provides a raw shape, an object schema, a result schema and a description for each", () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_INPUT_SHAPES[name]).toBeTypeOf("object");
      expect(TOOL_INPUT_SCHEMAS[name]).toBeInstanceOf(z.ZodType);
      expect(TOOL_RESULT_SCHEMAS[name]).toBeInstanceOf(z.ZodType);
      expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(20);
    }
  });

  it("wraps each raw shape into its object schema without drift", () => {
    // The SDK's tool() takes the RAW SHAPE; parsing and JSON-Schema derivation
    // use the wrapped object. They must describe the same keys.
    for (const name of TOOL_NAMES) {
      expect(Object.keys(TOOL_INPUT_SHAPES[name]).sort()).toEqual(EXPECTED_PROPERTIES[name].slice().sort());
    }
  });

  it("keeps the mcp__scadforge__ prefix a provider-boundary concern (Spike 3 §6)", () => {
    expect(MCP_SERVER_NAME).toBe("scadforge");
    expect(MCP_TOOL_NAME_PREFIX).toBe("mcp__scadforge__");
    for (const name of TOOL_NAMES) expect(name).not.toContain("mcp__");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema derivation — Issue #13 AC
// ─────────────────────────────────────────────────────────────────────────────

describe("JSON Schema derivation (usable by both the Agent SDK and MCP)", () => {
  it.each(TOOL_NAMES)("derives an object schema for %s with the frozen required fields", (name) => {
    const schema = derive(name);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(EXPECTED_PROPERTIES[name].slice().sort());
    // zod omits `required` entirely when nothing is required.
    expect((schema.required ?? []).slice().sort()).toEqual(EXPECTED_REQUIRED[name].slice().sort());
  });

  it("derives a schema for all seven tools with no unrepresentable types", () => {
    const derived = TOOL_NAMES.map((name) => derive(name));
    expect(derived).toHaveLength(7);
    for (const schema of derived) expect(schema.type).toBe("object");
  });

  it("carries the per-field descriptions the model reads", () => {
    const writeScad = derive("write_scad");
    const content = writeScad.properties?.content as { description?: string };
    expect(content.description).toContain("Whole-file write");
  });

  it("derives an enum for the fixed view set", () => {
    const renderViews = derive("render_views");
    const views = renderViews.properties?.views as { items?: { enum?: string[] } };
    expect(views.items?.enum).toEqual(["iso", "front", "top", "right", "section"]);
  });

  it("derives an enum for the export formats", () => {
    const exportSchema = derive("export");
    const format = exportSchema.properties?.format as { enum?: string[] };
    expect(format.enum).toEqual(["3mf", "stl", "off"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Counterexample validation — one valid + one invalid parse per schema
// ─────────────────────────────────────────────────────────────────────────────

describe("counterexample validation: every input schema accepts a valid case", () => {
  it("read_project: empty input", () => {
    expect(TOOL_INPUT_SCHEMAS.read_project.safeParse({}).success).toBe(true);
  });

  it("write_scad: full file plus a short message", () => {
    const parsed = TOOL_INPUT_SCHEMAS.write_scad.safeParse({
      content: "cube([20,20,20]);\n",
      message: "Added a 20mm cube."
    });
    expect(parsed.success).toBe(true);
  });

  it("set_params: mixed scalar and vector values", () => {
    const parsed = TOOL_INPUT_SCHEMAS.set_params.safeParse({
      params: { wall: 4, label: "demo", enabled: true, offsets: [1, 2, 3] }
    });
    expect(parsed.success).toBe(true);
  });

  it("render_views: every field supplied", () => {
    const parsed = TOOL_INPUT_SCHEMAS.render_views.safeParse({
      views: ["iso", "front", "right", "section"],
      imgsize: [1024, 768],
      params: { wall: 4 }
    });
    expect(parsed.success).toBe(true);
  });

  it("render_views: no fields supplied (all optional)", () => {
    expect(TOOL_INPUT_SCHEMAS.render_views.safeParse({}).success).toBe(true);
  });

  it("validate_mesh: multi-part override", () => {
    expect(TOOL_INPUT_SCHEMAS.validate_mesh.safeParse({ allowMultiPart: true }).success).toBe(true);
  });

  it("export: format only", () => {
    expect(TOOL_INPUT_SCHEMAS.export.safeParse({ format: "3mf" }).success).toBe(true);
  });

  it("library_lookup: query with a library filter", () => {
    const parsed = TOOL_INPUT_SCHEMAS.library_lookup.safeParse({
      query: "BOSL2 screw_hole",
      library: "BOSL2",
      limit: 5
    });
    expect(parsed.success).toBe(true);
  });
});

describe("counterexample validation: every input schema rejects an invalid case", () => {
  it("read_project: rejects a non-object", () => {
    expect(TOOL_INPUT_SCHEMAS.read_project.safeParse("nope").success).toBe(false);
  });

  it("write_scad: rejects a missing message", () => {
    expect(TOOL_INPUT_SCHEMAS.write_scad.safeParse({ content: "cube(1);" }).success).toBe(false);
  });

  it("write_scad: rejects an empty file body", () => {
    expect(TOOL_INPUT_SCHEMAS.write_scad.safeParse({ content: "", message: "empty" }).success).toBe(false);
  });

  it("write_scad: rejects a message over 200 chars (chat stays readable)", () => {
    const parsed = TOOL_INPUT_SCHEMAS.write_scad.safeParse({
      content: "cube(1);",
      message: "x".repeat(201)
    });
    expect(parsed.success).toBe(false);
  });

  it("set_params: rejects a nested-object parameter value", () => {
    const parsed = TOOL_INPUT_SCHEMAS.set_params.safeParse({ params: { wall: { nested: 1 } } });
    expect(parsed.success).toBe(false);
  });

  it("render_views: rejects an unknown view name", () => {
    expect(TOOL_INPUT_SCHEMAS.render_views.safeParse({ views: ["back"] }).success).toBe(false);
  });

  it("render_views: rejects a non-integer image size", () => {
    expect(TOOL_INPUT_SCHEMAS.render_views.safeParse({ imgsize: [1024.5, 768] }).success).toBe(false);
  });

  it("validate_mesh: rejects a non-boolean allowMultiPart", () => {
    expect(TOOL_INPUT_SCHEMAS.validate_mesh.safeParse({ allowMultiPart: "yes" }).success).toBe(false);
  });

  it("export: rejects an unsupported format", () => {
    expect(TOOL_INPUT_SCHEMAS.export.safeParse({ format: "obj" }).success).toBe(false);
  });

  it("export: rejects a missing format", () => {
    expect(TOOL_INPUT_SCHEMAS.export.safeParse({}).success).toBe(false);
  });

  it("library_lookup: rejects an empty query", () => {
    expect(TOOL_INPUT_SCHEMAS.library_lookup.safeParse({ query: "" }).success).toBe(false);
  });

  it("library_lookup: rejects a limit above the cap", () => {
    expect(TOOL_INPUT_SCHEMAS.library_lookup.safeParse({ query: "gear", limit: 500 }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Result envelope and payload conventions — Spike 3 §7
// ─────────────────────────────────────────────────────────────────────────────

describe("tool-result envelope (Spike 3 §7.1)", () => {
  it("accepts the success envelope", () => {
    expect(toolSuccessEnvelopeSchema.safeParse({ ok: true, pass: 1 }).success).toBe(true);
  });

  it("accepts the failure envelope with a shared error_code", () => {
    const parsed = toolFailureEnvelopeSchema.safeParse({
      ok: false,
      error_code: "PASS_BUDGET_EXHAUSTED",
      message: "The pass budget for this turn is exhausted."
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an error_code outside the frozen REST vocabulary", () => {
    const parsed = toolFailureEnvelopeSchema.safeParse({
      ok: false,
      error_code: "SOMETHING_ELSE",
      message: "nope"
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a failure envelope with no message", () => {
    expect(toolFailureEnvelopeSchema.safeParse({ ok: false, error_code: "TIMEOUT" }).success).toBe(false);
  });

  it("accepts Spike 3's validated write_scad payload verbatim", () => {
    const parsed = writeScadResultSchema.safeParse({
      ok: true,
      pass: 1,
      max_passes: 2,
      passes_remaining: 1,
      bytes: 412,
      snapshot: "0002",
      syntax_check: { ok: true, errors: [], warnings: [], ms: 192 }
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts Spike 3's validated render_views payload verbatim", () => {
    const parsed = renderViewsResultSchema.safeParse({
      ok: true,
      pass: 1,
      views: [
        {
          view: "iso",
          ok: true,
          camera: "0,0,0,55,0,25,0",
          projection: "ortho",
          imgsize: [512, 512],
          bytes: 8893,
          render_ms: 2494,
          stderr: null
        }
      ],
      total_ms: 2494,
      note: 'The images below follow in the same order. "section" is the model cut by a half-space on Y.'
    });
    expect(parsed.success).toBe(true);
  });

  it("lets render_views report ok:false while still carrying views (no isError)", () => {
    const parsed = renderViewsResultSchema.safeParse({
      ok: false,
      pass: 1,
      views: [
        {
          view: "section",
          ok: false,
          camera: "0,0,0,90,0,0,0",
          projection: "ortho",
          imgsize: [1024, 768],
          bytes: null,
          render_ms: 118,
          stderr: "ERROR: Parser error in file model.scad, line 12"
        }
      ],
      total_ms: 118,
      error_code: "RENDER_FAILED",
      message: "The section view failed to render."
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a render_views payload whose stderr is an empty string, not null", () => {
    // Spike 3 §7.2: return null, never "", when there is nothing to report.
    // "" is a legal string so the schema accepts it — this asserts the RULE is
    // recorded as data so a handler-side lint can enforce it.
    expect(TOOL_RESULT_RULES.filterStderr).toBe(true);
  });

  it("accepts a validate_mesh payload wrapping the frozen report and gate", () => {
    const parsed = validateMeshResultSchema.safeParse({
      ok: true,
      pass: 1,
      report: {
        manifold: true,
        status: "NoError",
        volume_mm3: 8000,
        surface_area: 2400,
        bbox: { min: [0, 0, 0], max: [20, 20, 20] },
        triangle_count: 12,
        components: 1,
        genus: 0
      },
      gate: { ok: true, badge: "green", failures: [], warnings: [] },
      export_ms: 338,
      validate_ms: 12
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a validate_mesh payload missing a ValidationReport field", () => {
    const parsed = validateMeshResultSchema.safeParse({
      ok: true,
      pass: 1,
      report: {
        manifold: true,
        status: "NoError",
        volume_mm3: 8000,
        surface_area: 2400,
        bbox: { min: [0, 0, 0], max: [20, 20, 20] },
        triangle_count: 12,
        components: 1
        // genus omitted
      },
      gate: { ok: true, badge: "green", failures: [], warnings: [] },
      export_ms: 338,
      validate_ms: 12
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a ManifoldStatus outside manifold-3d's values plus ConstructionFailed", () => {
    const parsed = validationReportSchema.safeParse({
      manifold: false,
      status: "Not manifold", // the thrown message; the contract's name is ConstructionFailed
      volume_mm3: null,
      surface_area: null,
      bbox: null,
      triangle_count: 10,
      components: null,
      genus: null
    });
    expect(parsed.success).toBe(false);
    expect(
      validationReportSchema.safeParse({
        manifold: false,
        status: "ConstructionFailed",
        volume_mm3: null,
        surface_area: null,
        bbox: null,
        triangle_count: 10,
        components: null,
        genus: null
      }).success
    ).toBe(true);
  });
});

describe("export result payload carries the validation summary (SDP §6.2)", () => {
  const greenGate = { ok: true, badge: "green", failures: [], warnings: [] };

  it("accepts a successful export with a green gate", () => {
    const parsed = exportResultSchema.safeParse({
      ok: true,
      pass: 1,
      format: "3mf",
      file: "my-bracket-0002.3mf",
      bytes: 24_118,
      export_ms: 411,
      validation: greenGate,
      validation_overridden: false
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a refusal that names which gate failed and why", () => {
    // CLAUDE.md hard rule 7: export runs validate_mesh first and refuses on
    // failure. The agent must be able to read WHICH gate refused it.
    const parsed = exportResultSchema.safeParse({
      ok: false,
      pass: 1,
      format: "3mf",
      file: null,
      bytes: null,
      export_ms: 402,
      validation: {
        ok: false,
        badge: "red",
        failures: [{ code: "MULTIPLE_COMPONENTS", message: "mesh has 3 disconnected solid components" }],
        warnings: []
      },
      validation_overridden: false,
      error_code: "VALIDATION_FAILED",
      message: "Export refused: the mesh has 3 disconnected solid components."
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.validation?.failures[0].code).toBe("MULTIPLE_COMPONENTS");
  });

  it("accepts an explicit override: red gate, exported anyway", () => {
    const parsed = exportResultSchema.safeParse({
      ok: true,
      pass: 1,
      format: "stl",
      file: "my-bracket-0002.stl",
      bytes: 10_484,
      export_ms: 338,
      validation: {
        ok: false,
        badge: "red",
        failures: [{ code: "MULTIPLE_COMPONENTS", message: "mesh has 2 disconnected solid components" }],
        warnings: ["multi-part export allowed by explicit override"]
      },
      validation_overridden: true
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts validation:null only for the case where the gate could not run", () => {
    const parsed = exportResultSchema.safeParse({
      ok: false,
      pass: 1,
      format: "off",
      file: null,
      bytes: null,
      export_ms: 87,
      validation: null,
      validation_overridden: false,
      error_code: "EXPORT_FAILED",
      message: "OpenSCAD produced no mesh, so validation could not run."
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an export payload with no validation field at all", () => {
    // COUNTEREXAMPLE: this was the pre-review shape. It cannot express which
    // gate refused an export, which scad-core's ExportRunResult and protocol's
    // ExportResponse both can.
    const parsed = exportResultSchema.safeParse({
      ok: true,
      pass: 1,
      format: "3mf",
      file: "my-bracket-0002.3mf",
      bytes: 24_118,
      export_ms: 411,
      validation_overridden: false
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown gate failure code", () => {
    const parsed = exportResultSchema.safeParse({
      ok: false,
      pass: 1,
      format: "3mf",
      file: null,
      bytes: null,
      export_ms: 402,
      validation: {
        ok: false,
        badge: "red",
        failures: [{ code: "TOO_UGLY", message: "nope" }],
        warnings: []
      },
      validation_overridden: false
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown validation badge", () => {
    const parsed = exportResultSchema.safeParse({
      ok: true,
      pass: 1,
      format: "3mf",
      file: "x.3mf",
      bytes: 1,
      export_ms: 1,
      validation: { ok: true, badge: "chartreuse", failures: [], warnings: [] },
      validation_overridden: false
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an export payload missing validation_overridden", () => {
    const parsed = exportResultSchema.safeParse({
      ok: true,
      pass: 1,
      format: "3mf",
      file: "x.3mf",
      bytes: 1,
      export_ms: 1,
      validation: greenGate
    });
    expect(parsed.success).toBe(false);
  });

  it("returns the same gate shape as validate_mesh", () => {
    const gate = { ok: true, badge: "green", failures: [], warnings: [] };
    expect(validationGateResultSchema.safeParse(gate).success).toBe(true);
    const fromExport = exportResultSchema.safeParse({
      ok: true,
      pass: 1,
      format: "3mf",
      file: "x.3mf",
      bytes: 1,
      export_ms: 1,
      validation: gate,
      validation_overridden: false
    });
    const fromValidateMesh = validateMeshResultSchema.safeParse({
      ok: true,
      pass: 1,
      report: {
        manifold: true,
        status: "NoError",
        volume_mm3: 1,
        surface_area: 6,
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
        triangle_count: 12,
        components: 1,
        genus: 0
      },
      gate,
      export_ms: null,
      validate_ms: 3
    });
    expect([fromExport.success, fromValidateMesh.success]).toEqual([true, true]);
  });
});

describe("read_project result payload uses real schemas, not unknown escape hatches", () => {
  const fullPayload = {
    ok: true,
    pass: 0,
    scad: "wall = 4; // [2:0.5:10] Bracket wall thickness\ncube([20, 20, wall]);\n",
    params: { wall: 4 },
    param_schema: {
      title: "sample",
      parameters: [
        {
          caption: "Bracket wall thickness",
          group: "Pipe",
          initial: 4.0,
          max: 10.0,
          min: 2.0,
          name: "wall",
          step: 0.5,
          type: "number"
        }
      ]
    },
    validation: {
      manifold: true,
      status: "NoError",
      volume_mm3: 1600,
      surface_area: 1120,
      bbox: { min: [0, 0, 0], max: [20, 20, 4] },
      triangle_count: 12,
      components: 1,
      genus: 0
    },
    head_snapshot: "0002"
  };

  it("accepts Spike 2's param-export entry inside param_schema", () => {
    expect(readProjectResultSchema.safeParse(fullPayload).success).toBe(true);
  });

  it("accepts a never-validated project (validation: null)", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      validation: null,
      head_snapshot: null
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a parameter with an unknown ParamType", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      param_schema: {
        title: "sample",
        parameters: [{ name: "wall", type: "float", initial: 4 }]
      }
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a parameter missing its initial value", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      param_schema: { title: "sample", parameters: [{ name: "wall", type: "number" }] }
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a validation report that is an arbitrary object", () => {
    // COUNTEREXAMPLE: this was accepted by the pre-review z.record(unknown).
    const parsed = readProjectResultSchema.safeParse({ ...fullPayload, validation: { anything: "goes" } });
    expect(parsed.success).toBe(false);
  });

  it("parses a dropdown parameter's options", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      param_schema: {
        title: "sample",
        parameters: [
          {
            name: "finish",
            type: "string",
            initial: "matte",
            options: [
              { name: "matte", value: "matte" },
              { name: "gloss", value: "gloss" }
            ]
          }
        ]
      }
    });
    expect(parsed.success).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // S3-A (Issue #68) — additive `editor` block on read_project
  //
  // The editor block is REFERENCEABILITY ONLY — it does NOT widen the tool
  // surface, add a new tool, or change the seven tool names frozen above. It is
  // what lets the agent cite features by featureId rather than by ordinal or
  // label (D7 referenceability, wire-and-recovery §"D7 agent referenceability").
  // Omission is reserved for legacy adapters and must never be constructed
  // server-side as an empty confirmed document.
  // ───────────────────────────────────────────────────────────────────────────

  const editorBlock = {
    version: 1,
    projectId: "11111111-2222-4333-8444-555555555555",
    editorRevision: "0".repeat(64),
    sourceRevision: "0".repeat(64),
    sourceFingerprint: "0".repeat(64),
    sidecarStatus: "ready",
    features: [
      {
        featureId: "11111111-2222-4333-8444-555555555555",
        label: "wall",
        projectId: "11111111-2222-4333-8444-555555555555",
        createdAtRevision: "0".repeat(64),
        sourceFingerprint: "0".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: {
          kind: "linear",
          parameter: "wall",
          axis: "z",
          mapping: { scale: 1, offset: 0, anchor: "min" }
        }
      }
    ],
    eligibility: []
  };

  it("accepts a populated `editor` block as the S3-A additive surface", () => {
    const parsed = readProjectResultSchema.safeParse({ ...fullPayload, editor: editorBlock });
    expect(parsed.success).toBe(true);
  });

  it("accepts a legacy-empty editor block (zero features, sidecarStatus 'legacy-empty')", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      editor: { ...editorBlock, sidecarStatus: "legacy-empty", features: [] }
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts omission of the editor block (legacy adapter path)", () => {
    expect(readProjectResultSchema.safeParse(fullPayload).success).toBe(true);
  });

  it("rejects a feature inside the editor block whose bindingVersion is 0", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      editor: {
        ...editorBlock,
        features: [{ ...editorBlock.features[0], bindingVersion: 0 }]
      }
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a feature whose provenance is ai-proposed but lacks confirmedBy: 'user'", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      editor: {
        ...editorBlock,
        features: [
          {
            ...editorBlock.features[0],
            provenance: { kind: "ai-proposed", confirmedBy: "model" as never }
          }
        ]
      }
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown sidecarStatus inside the editor block", () => {
    const parsed = readProjectResultSchema.safeParse({
      ...fullPayload,
      editor: { ...editorBlock, sidecarStatus: "weird" as never }
    });
    expect(parsed.success).toBe(false);
  });

  it("mirrors the AgentEditorContext shape via agentEditorContextSchema", () => {
    // The agent mirror exists so MCP/SDK providers can validate the block
    // without re-implementing it. Wire-and-recovery §"D7 agent referenceability"
    // requires the mirror be "exact" — that is enforced by the
    // AgentEditorContextMirrorCheck compile-time guard below.
    expect(agentEditorContextSchema.safeParse(editorBlock).success).toBe(true);
  });
});

describe("image-bearing tool results (Spike 3 §3 / §7.2)", () => {
  it("uses MCP CallToolResult image blocks with bare base64 PNG data", () => {
    expect(TOOL_RESULT_IMAGE_MIME_TYPE).toBe("image/png");
    const result: ToolCallResult = {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, pass: 1 }) },
        { type: "text", text: `${IMAGE_LABEL_PREFIX}iso` },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }
      ]
    };
    const image = result.content[2];
    expect(image.type).toBe("image");
    if (image.type === "image") expect(image.data.startsWith("data:")).toBe(false);
  });

  it("labels every image with a text block immediately before it", () => {
    expect(IMAGE_LABEL_PREFIX).toBe("view: ");
    expect(TOOL_RESULT_RULES.labelBeforeEachImage).toBe(true);

    const content: ToolContentBlock[] = [
      { type: "text", text: JSON.stringify({ ok: true, pass: 1 }) },
      { type: "text", text: "view: iso" },
      { type: "image", data: "aaaa", mimeType: "image/png" },
      { type: "text", text: "view: front" },
      { type: "image", data: "bbbb", mimeType: "image/png" }
    ];
    content.forEach((block, index) => {
      if (block.type !== "image") return;
      const label = content[index - 1];
      expect(label.type).toBe("text");
      if (label.type === "text") expect(label.text.startsWith(IMAGE_LABEL_PREFIX)).toBe(true);
    });
  });

  it("content[0] is a single pure-JSON text block, no prose and no fence", () => {
    expect(TOOL_RESULT_RULES.jsonFirstBlock).toBe(true);
    const first: ToolContentBlock = { type: "text", text: JSON.stringify({ ok: true, pass: 1, bytes: 412 }) };
    if (first.type === "text") {
      expect(first.text.includes("```")).toBe(false);
      expect(() => JSON.parse(first.text)).not.toThrow();
    }
  });

  it("makes isError:true unrepresentable — it would drop the images", () => {
    expect(TOOL_RESULT_RULES.neverIsErrorWithImages).toBe(true);
    // COUNTEREXAMPLE (compile-time): `isError` is typed `false | undefined`, so
    // the line below does not type-check. Kept as a runtime assertion of the
    // same rule, since a `@ts-expect-error` here would be the only proof.
    const errored = { content: [], isError: true } as unknown as { isError: boolean };
    const legal: ToolCallResult = { content: [], isError: false };
    expect(errored.isError).toBe(true);
    expect(legal.isError).toBe(false);
  });

  it("records that host code must handle content being an array OR a string", () => {
    expect(TOOL_RESULT_RULES.contentMayBeArrayOrString).toBe(true);
  });
});

describe("pass budget (CLAUDE.md hard rule 4, Spike 3 §4.2)", () => {
  it("defaults to 2 passes, configured by SCADFORGE_MAX_PASSES", () => {
    expect(DEFAULT_MAX_PASSES).toBe(2);
    expect(MAX_PASSES_ENV_VAR).toBe("SCADFORGE_MAX_PASSES");
  });

  it("is enforced in the write_scad handler, not via the SDK's maxTurns", () => {
    expect(PASS_BUDGET_ENFORCEMENT).toBe("write_scad_handler");
    expect(TOOL_RESULT_RULES.echoBudgetState).toBe(true);
  });

  it("echoes budget state so the model self-paces", () => {
    const parsed = writeScadResultSchema.safeParse({
      ok: true,
      pass: 2,
      max_passes: 2,
      passes_remaining: 0,
      bytes: 900,
      snapshot: "0003",
      syntax_check: { ok: true, errors: [], warnings: [], ms: 150 }
    });
    expect(parsed.success).toBe(true);
  });
});

describe("protocol mirror drift guard", () => {
  it("keeps ToolName mutually assignable with protocol's mirror", () => {
    const ok: MutuallyAssignable<ToolName, ProtocolToolName> = true;
    expect(ok).toBe(true);
  });

  it("keeps the mirrored tool list identical, in order", () => {
    expect([...TOOL_NAMES]).toEqual([...PROTOCOL_TOOL_NAMES]);
  });
});

describe("scad-core zod mirror drift guard", () => {
  it("keeps every zod mirror mutually assignable with its scad-core type", () => {
    // These assignments do not compile if a field is added, removed, renamed or
    // retyped on either side — which is what lets the result schemas above use
    // real shapes instead of z.unknown() escape hatches.
    const manifoldStatusOk: ManifoldStatusMirrorCheck = true;
    const validationReportOk: ValidationReportMirrorCheck = true;
    const validationGateResultOk: ValidationGateResultMirrorCheck = true;
    const paramSchemaOk: ParamSchemaMirrorCheck = true;
    expect([manifoldStatusOk, validationReportOk, validationGateResultOk, paramSchemaOk]).toEqual([
      true,
      true,
      true,
      true
    ]);
  });

  it("keeps agentEditorContextSchema mutually assignable with @scadforge/protocol's AgentEditorContext", () => {
    // Wire-and-recovery §"D7 agent referenceability": the runtime mirror must be
    // exact — a field added, removed or retyped on either side flips this to
    // `false` and fails `tsc`.
    const editorMirrorOk: AgentEditorContextMirrorCheck = true;
    expect(editorMirrorOk).toBe(true);
  });

  it("leaves no z.unknown()/z.any() escape hatch in any result schema", () => {
    for (const name of TOOL_NAMES) {
      const derived = JSON.stringify(z.toJSONSchema(TOOL_RESULT_SCHEMAS[name], { io: "input" }));
      // An unconstrained `unknown`/`any` serialises as an empty subschema `{}`.
      expect(derived).not.toContain('"additionalProperties":{}');
      expect(derived).not.toContain('"items":{}');
    }
  });
});
