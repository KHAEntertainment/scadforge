// FROZEN CONTRACT — ScadForge Issue #13. These assertions are the proof for
// `src/types.ts`: they byte-match the camera constants against
// PROJECT_CONTEXT.md's Spike Decisions and pin `ValidationReport` to Spike 4's
// merged proposal. Do NOT edit them inside a feature PR — changes require a
// Tech-Lead-approved contract-change issue, merged separately.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS as PROTOCOL_EXPORT_FORMATS,
  VIEW_NAMES as PROTOCOL_VIEW_NAMES
} from "@scadforge/protocol";
import type {
  ExportFormat as ProtocolExportFormat,
  ParamValue as ProtocolParamValue,
  ViewName as ProtocolViewName
} from "@scadforge/protocol";
import {
  DEFAULT_BACKEND,
  DEFAULT_COLORSCHEME,
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_PROJECTION,
  DEFAULT_RENDER_TIMEOUT_MS,
  DEFAULT_VIEWS,
  EXPORT_FORMATS,
  OPENSCAD_EXPORT_FORMAT_FLAG,
  OPENSCAD_IMAGE,
  OPENSCAD_PARAM_EXPORT_FORMAT,
  OPENSCAD_VERSION,
  PARAMS_ACTIVE_PRESET,
  PARAMS_FILE_FORMAT_VERSION,
  RENDER_COMMON_FLAGS,
  SECTION_VIEW_CONTRACT,
  SECTION_WRAPPER_MESH_TOKEN,
  SECTION_WRAPPER_TEMPLATE,
  VALIDATION_GATE_DEFAULTS,
  VIEW_CAMERA_ARGS,
  VIEW_CAMERA_ROTATIONS,
  VIEW_NAMES
} from "./types.js";
import type {
  ExportFormat,
  ManifoldStatus,
  ParamSchema,
  ParamValue,
  ParamsFile,
  ValidationGateResult,
  ValidationReport,
  ViewName
} from "./types.js";

/** True only when A and B are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ─────────────────────────────────────────────────────────────────────────────
// Camera constants — byte-match PROJECT_CONTEXT.md "Spike Decisions"
// ─────────────────────────────────────────────────────────────────────────────

describe("frozen camera constants (PROJECT_CONTEXT.md Spike Decisions)", () => {
  it("matches the frozen common flag set verbatim, in order", () => {
    // PROJECT_CONTEXT.md: "common flags `--viewall --autocenter
    // --projection=ortho --imgsize=1024,768 --backend=Manifold --render
    // --colorscheme=Cornfield`"
    expect(RENDER_COMMON_FLAGS.join(" ")).toBe(
      "--viewall --autocenter --projection=ortho --imgsize=1024,768 --backend=Manifold --render --colorscheme=Cornfield"
    );
  });

  it("matches the frozen per-view rotations verbatim", () => {
    // PROJECT_CONTEXT.md: "rotations iso `55,0,25`, front `90,0,0`,
    // top `0,0,0`, right `90,0,90`"
    expect(VIEW_CAMERA_ROTATIONS.iso.join(",")).toBe("55,0,25");
    expect(VIEW_CAMERA_ROTATIONS.front.join(",")).toBe("90,0,0");
    expect(VIEW_CAMERA_ROTATIONS.top.join(",")).toBe("0,0,0");
    expect(VIEW_CAMERA_ROTATIONS.right.join(",")).toBe("90,0,90");
  });

  it("reuses front's camera for the section view (Spike 2 camera table)", () => {
    expect(VIEW_CAMERA_ROTATIONS.section).toEqual(VIEW_CAMERA_ROTATIONS.front);
    expect(VIEW_CAMERA_ARGS.section).toBe(VIEW_CAMERA_ARGS.front);
  });

  it("renders each rotation into OpenSCAD's gimbal --camera= form with 0 placeholders", () => {
    // --autocenter recomputes tx,ty,tz and --viewall recomputes dist, so
    // those four positions are always 0.
    for (const view of VIEW_NAMES) {
      const parts = VIEW_CAMERA_ARGS[view].split(",");
      expect(parts).toHaveLength(7);
      expect([parts[0], parts[1], parts[2], parts[6]]).toEqual(["0", "0", "0", "0"]);
      expect(parts.slice(3, 6).join(",")).toBe(VIEW_CAMERA_ROTATIONS[view].join(","));
    }
  });

  it("keeps the derived flag values consistent with the frozen flag string", () => {
    expect(RENDER_COMMON_FLAGS).toContain(`--imgsize=${DEFAULT_IMAGE_SIZE[0]},${DEFAULT_IMAGE_SIZE[1]}`);
    expect(RENDER_COMMON_FLAGS).toContain(`--colorscheme=${DEFAULT_COLORSCHEME}`);
    expect(RENDER_COMMON_FLAGS).toContain(`--projection=${DEFAULT_PROJECTION}`);
    expect(RENDER_COMMON_FLAGS).toContain(`--backend=${DEFAULT_BACKEND}`);
    expect(DEFAULT_IMAGE_SIZE).toEqual([1024, 768]);
    expect(DEFAULT_RENDER_TIMEOUT_MS).toBe(60_000);
  });

  it("pins OpenSCAD by digest, not by a floating tag", () => {
    expect(OPENSCAD_IMAGE).toBe(
      "docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7"
    );
    expect(OPENSCAD_VERSION).toBe("2026.01.19 (git e43242666)");
  });
});

describe("view set", () => {
  it("is the five fixed views", () => {
    expect([...VIEW_NAMES]).toEqual(["iso", "front", "top", "right", "section"]);
  });

  it("defaults to iso/front/right/section — 'top' on request only (Spike 3 §8)", () => {
    expect([...DEFAULT_VIEWS]).toEqual(["iso", "front", "right", "section"]);
    expect(DEFAULT_VIEWS).not.toContain("top");
    expect(VIEW_NAMES).toContain("top");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section view — two-pass, SPIKE OVERRIDES SDP §6.2
// ─────────────────────────────────────────────────────────────────────────────

describe("section view contract (Spike 2 §'Section view: a correction')", () => {
  it("is a two-pass render: mesh export, then import() + difference()", () => {
    expect(SECTION_VIEW_CONTRACT.passes).toBe(2);
    expect(SECTION_WRAPPER_TEMPLATE).toContain("import(");
    expect(SECTION_WRAPPER_TEMPLATE).toContain("difference()");
  });

  it("never uses the single-pass `include` wrapper SDP §6.2 sketched (it does not parse)", () => {
    expect(SECTION_WRAPPER_TEMPLATE).not.toContain("include");
  });

  it("removes the -Y half-space so the cut face points at the section camera", () => {
    expect(SECTION_VIEW_CONTRACT.axis).toBe("y");
    expect(SECTION_VIEW_CONTRACT.removeHalf).toBe("negative");
    const [tx, ty, tz] = SECTION_VIEW_CONTRACT.cubeTranslate;
    const [sx, sy, sz] = SECTION_VIEW_CONTRACT.cubeSize;
    // The cube must span y in [-2000, 0] — i.e. it removes y < 0, not y > 0.
    expect(ty + sy).toBe(0);
    expect(ty).toBeLessThan(0);
    // ...and be symmetric about the origin on x and z so nothing else is cut.
    expect(tx + sx).toBe(-tx);
    expect(tz + sz).toBe(-tz);
  });

  it("keeps the wrapper template and the contract's cube numbers in step", () => {
    expect(SECTION_WRAPPER_TEMPLATE).toContain(`translate([${SECTION_VIEW_CONTRACT.cubeTranslate.join(", ")}])`);
    expect(SECTION_WRAPPER_TEMPLATE).toContain(`cube([${SECTION_VIEW_CONTRACT.cubeSize.join(", ")}])`);
  });

  it("substitutes the mesh path through a single token", () => {
    expect(SECTION_WRAPPER_TEMPLATE).toContain(SECTION_WRAPPER_MESH_TOKEN);
    const wrapper = SECTION_WRAPPER_TEMPLATE.replace(SECTION_WRAPPER_MESH_TOKEN, "mesh.off");
    expect(wrapper).toBe(
      'difference() {\n  import("mesh.off");\n  translate([-1000, -2000, -1000]) cube([2000, 2000, 2000]);\n}\n'
    );
    expect(wrapper).not.toContain(SECTION_WRAPPER_MESH_TOKEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ValidationReport — Spike 4's merged proposal
// ─────────────────────────────────────────────────────────────────────────────

describe("ValidationReport (Spike 4 merged proposal)", () => {
  it("accepts Spike 4's `good.stl` output verbatim", () => {
    // docs/spikes/04-manifold-validate/README.md §"Real outputs"
    const report: ValidationReport = {
      manifold: true,
      status: "NoError",
      volume_mm3: 8000,
      surface_area: 2400,
      bbox: { min: [0, 0, 0], max: [20, 20, 20] },
      triangle_count: 12,
      components: 1,
      genus: 0
    };
    expect(Object.keys(report)).toEqual([
      "manifold",
      "status",
      "volume_mm3",
      "surface_area",
      "bbox",
      "triangle_count",
      "components",
      "genus"
    ]);
  });

  it("accepts the non-manifold case: measurements null, triangle_count still present", () => {
    // Spike 4's `bad-mesh.stl` row. The spike's raw output prints the thrown
    // message "Not manifold"; the contract's name for that case is
    // 'ConstructionFailed'.
    const report: ValidationReport = {
      manifold: false,
      status: "ConstructionFailed",
      volume_mm3: null,
      surface_area: null,
      bbox: null,
      triangle_count: 10,
      components: null,
      genus: null
    };
    expect(report.triangle_count).toBe(10);
    expect(report.volume_mm3).toBeNull();
  });

  it("accepts the multi-island case, where genus is a meaningless 1-k artifact", () => {
    // Spike 4's `multi-island.stl` row: 2 components → reported genus 1-2 = -1.
    const report: ValidationReport = {
      manifold: true,
      status: "NoError",
      volume_mm3: 2000,
      surface_area: 1200,
      bbox: { min: [0, 0, 0], max: [40, 10, 10] },
      triangle_count: 24,
      components: 2,
      genus: -1
    };
    // Contract implication: only trust genus when components === 1.
    expect(report.components).not.toBe(1);
    expect(report.genus).toBe(-1);
  });

  it("keeps ManifoldStatus to manifold-3d's values plus ConstructionFailed", () => {
    const statuses: ManifoldStatus[] = [
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
    ];
    expect(statuses).toHaveLength(16);
    // COUNTEREXAMPLE: Spike 3's hand-rolled edge-pairing fields are NOT part of
    // this contract — Spike 3 §8 found that analysis unreliable and Spike 4
    // replaced it with manifold-3d's status().
    const report: ValidationReport = {
      manifold: true,
      status: "NoError",
      volume_mm3: 1,
      surface_area: 6,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      triangle_count: 12,
      components: 1,
      genus: 0
    };
    for (const absent of ["watertight", "boundary_edges", "non_manifold_edges", "degenerate_triangles"]) {
      expect(Object.keys(report)).not.toContain(absent);
    }
  });
});

describe("validation gate thresholds (Spike 4 §'Suggested thresholds')", () => {
  it("freezes volume > 0.001 and components === 1 with an allowMultiPart override", () => {
    expect(VALIDATION_GATE_DEFAULTS.minVolumeMm3).toBe(0.001);
    expect(VALIDATION_GATE_DEFAULTS.allowMultiPart).toBe(false);
  });

  it("keeps pass/fail and warnings out of ValidationReport, in the gate result", () => {
    const gate: ValidationGateResult = {
      ok: false,
      badge: "red",
      failures: [{ code: "MULTIPLE_COMPONENTS", message: "mesh has 3 disconnected solid components" }],
      warnings: []
    };
    expect(gate.failures[0].code).toBe("MULTIPLE_COMPONENTS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parameter model
// ─────────────────────────────────────────────────────────────────────────────

describe("Customizer parameter model (--export-format=param)", () => {
  it("accepts Spike 2's param-export sample entry field-for-field", () => {
    // docs/spikes/02-docker-cli/README.md §"AC verification" item 4, verbatim.
    const schema: ParamSchema = {
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
    };
    expect(schema.parameters[0].name).toBe("wall");
    expect(schema.parameters[0].group).toBe("Pipe");
    expect(schema.parameters[0].step).toBe(0.5);
  });

  it("supports dropdown parameters from `// [a, b, c]`", () => {
    const schema: ParamSchema = {
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
    };
    expect(schema.parameters[0].options).toHaveLength(2);
  });

  it("models params.json as an OpenSCAD preset file with a single `current` preset", () => {
    const file: ParamsFile = {
      fileFormatVersion: PARAMS_FILE_FORMAT_VERSION,
      parameterSets: { [PARAMS_ACTIVE_PRESET]: { wall: "4", smooth_fn: 48, enabled: true } }
    };
    expect(PARAMS_FILE_FORMAT_VERSION).toBe("1");
    expect(PARAMS_ACTIVE_PRESET).toBe("current");
    expect(Object.keys(file.parameterSets)).toEqual(["current"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

describe("export formats", () => {
  it("offers 3mf/stl/off with 3mf as the color-preserving default", () => {
    expect([...EXPORT_FORMATS]).toEqual(["3mf", "stl", "off"]);
    expect(DEFAULT_EXPORT_FORMAT).toBe("3mf");
  });

  it("maps stl to binstl — OpenSCAD's STL default is ASCII (Spike 4)", () => {
    expect(OPENSCAD_EXPORT_FORMAT_FLAG.stl).toBe("binstl");
    expect(OPENSCAD_EXPORT_FORMAT_FLAG["3mf"]).toBe("3mf");
    expect(OPENSCAD_EXPORT_FORMAT_FLAG.off).toBe("off");
    expect(OPENSCAD_PARAM_EXPORT_FORMAT).toBe("param");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mirror drift guard — see packages/protocol/src/vocabulary.ts MIRROR notice
// ─────────────────────────────────────────────────────────────────────────────

describe("protocol mirror drift guard", () => {
  it("keeps ViewName / ExportFormat / ParamValue mutually assignable with protocol's mirrors", () => {
    const viewNameOk: MutuallyAssignable<ViewName, ProtocolViewName> = true;
    const exportFormatOk: MutuallyAssignable<ExportFormat, ProtocolExportFormat> = true;
    const paramValueOk: MutuallyAssignable<ParamValue, ProtocolParamValue> = true;
    expect([viewNameOk, exportFormatOk, paramValueOk]).toEqual([true, true, true]);
  });

  it("keeps the mirrored member lists identical, in order", () => {
    expect([...VIEW_NAMES]).toEqual([...PROTOCOL_VIEW_NAMES]);
    expect([...EXPORT_FORMATS]).toEqual([...PROTOCOL_EXPORT_FORMATS]);
  });
});
