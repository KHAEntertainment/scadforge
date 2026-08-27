// SPDX-License-Identifier: Apache-2.0
//
// Handler unit tests. Every path runs against the in-memory seams — no Docker,
// no OpenSCAD, no API key (Issue #16 AC).

import { beforeEach, describe, expect, it } from "vitest";
import type { SseEvent } from "@scadforge/protocol";
import {
  IMAGE_LABEL_PREFIX,
  TOOL_NAMES,
  TOOL_RESULT_IMAGE_MIME_TYPE,
  TOOL_RESULT_SCHEMAS,
  readProjectResultSchema,
  renderViewsResultSchema,
  exportResultSchema,
  setParamsResultSchema,
  validateMeshResultSchema,
  writeScadResultSchema,
  libraryLookupResultSchema,
  type ToolCallResult
} from "./contract.js";
import { ToolActivityRecorder } from "./activity.js";
import { createToolHandlers, type ToolHandlerMap } from "./handlers.js";
import { PassBudget } from "./pass-budget.js";
import {
  MockLibraryIndex,
  MockScadCore,
  greenGate,
  healthyReport,
  redGate,
  renderedView
} from "../testing/mock-scad-core.js";

interface Harness {
  handlers: ToolHandlerMap;
  budget: PassBudget;
  activity: ToolActivityRecorder;
  events: SseEvent[];
  scadCore: MockScadCore;
  libraries: MockLibraryIndex;
}

function harness(
  scadCore: MockScadCore = new MockScadCore(),
  libraries: MockLibraryIndex = new MockLibraryIndex(),
  budget: PassBudget = new PassBudget({ maxPasses: 2 })
): Harness {
  const events: SseEvent[] = [];
  const activity = new ToolActivityRecorder();
  const handlers = createToolHandlers({
    scadCore,
    libraries,
    budget,
    activity,
    turnId: "turn-1",
    projectId: "proj-1",
    emit: (event) => events.push(event)
  });
  return { handlers, budget, activity, events, scadCore, libraries };
}

/** `content[0]` must be ONE text block of pure JSON — no prose, no fence. */
function envelope(result: ToolCallResult): any {
  expect(result.content[0].type).toBe("text");
  const text = (result.content[0] as { text: string }).text;
  expect(text.trimStart().startsWith("{")).toBe(true);
  return JSON.parse(text);
}

describe("createToolHandlers", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("registers a handler for all seven frozen tool names", () => {
    for (const name of TOOL_NAMES) expect(typeof h.handlers[name]).toBe("function");
    expect(Object.keys(TOOL_RESULT_SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("NEVER sets isError, on any tool, success or failure", async () => {
    const results = [
      await h.handlers.read_project({}),
      await h.handlers.write_scad({ content: "cube(10);", message: "cube" }),
      await h.handlers.render_views({}),
      await h.handlers.validate_mesh({}),
      await h.handlers.export({ format: "3mf" }),
      await h.handlers.library_lookup({ query: "cuboid" })
    ];
    for (const result of results) expect(result.isError).toBeUndefined();
  });
});

describe("read_project", () => {
  it("returns the frozen result shape", async () => {
    const h = harness();
    const payload = envelope(await h.handlers.read_project({}));
    expect(readProjectResultSchema.parse(payload)).toBeTruthy();
    expect(payload.pass).toBe(0);
    expect(payload.scad).toContain("cube");
  });

  it("turns a store failure into a non-error PROJECT_NOT_FOUND result", async () => {
    const scadCore = new MockScadCore({ failures: { readProject: new Error("no such project") } });
    const h = harness(scadCore);
    const result = await h.handlers.read_project({});
    expect(result.isError).toBeUndefined();
    expect(envelope(result)).toMatchObject({ ok: false, error_code: "PROJECT_NOT_FOUND" });
  });
});

describe("write_scad — the pass budget lives here", () => {
  it("opens a pass, echoes the budget and emits snapshot_created", async () => {
    const h = harness();
    const payload = envelope(await h.handlers.write_scad({ content: "cube(10);", message: "first cut" }));
    expect(writeScadResultSchema.parse(payload)).toBeTruthy();
    expect(payload).toMatchObject({ ok: true, pass: 1, max_passes: 2, passes_remaining: 1 });
    expect(h.budget.pass).toBe(1);

    const snapshots = h.events.filter((e) => e.type === "snapshot_created");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ turn_id: "turn-1", project_id: "proj-1" });
  });

  it("sanitizes the snapshot message host-side (CLAUDE.md rule 5)", async () => {
    const h = harness();
    await h.handlers.write_scad({
      content: "cube(10);",
      message: "added the boss\n```scad\ncube(10);\n```"
    });
    const written = h.scadCore.calls.find((c) => c.method === "writeScad")!.payload as { message: string };
    expect(written.message).toBe("added the boss");
    expect(written.message).not.toContain("cube");
  });

  it("reports SYNTAX_ERROR but STILL echoes the budget state", async () => {
    const scadCore = new MockScadCore({ syntaxErrors: ["ERROR: Parser error in file model.scad, line 3"] });
    const h = harness(scadCore);
    const payload = envelope(await h.handlers.write_scad({ content: "cube(", message: "broken" }));
    expect(payload).toMatchObject({
      ok: false,
      error_code: "SYNTAX_ERROR",
      pass: 1,
      max_passes: 2,
      passes_remaining: 1
    });
    expect(payload.syntax_check.ok).toBe(false);
    // A failed write still consumed a pass.
    expect(h.budget.pass).toBe(1);
  });

  it("refuses with PASS_BUDGET_EXHAUSTED once the cap is reached", async () => {
    const h = harness();
    await h.handlers.write_scad({ content: "a", message: "1" });
    h.budget.recordValidation(false);
    await h.handlers.write_scad({ content: "b", message: "2" });
    h.budget.recordValidation(false);
    const payload = envelope(await h.handlers.write_scad({ content: "c", message: "3" }));
    expect(payload).toMatchObject({
      ok: false,
      error_code: "PASS_BUDGET_EXHAUSTED",
      max_passes: 2,
      passes_remaining: 0
    });
    expect(payload.message).toMatch(/hand back a short summary/i);
    expect(h.budget.pass).toBe(2);
    expect(h.activity.hasRefusal("budget")).toBe(true);
  });

  it("honours SCADFORGE_MAX_PASSES=1", async () => {
    const h = harness(new MockScadCore(), new MockLibraryIndex(), new PassBudget({ maxPasses: 1 }));
    await h.handlers.write_scad({ content: "a", message: "1" });
    h.budget.recordValidation(false);
    const payload = envelope(await h.handlers.write_scad({ content: "b", message: "2" }));
    expect(payload.error_code).toBe("PASS_BUDGET_EXHAUSTED");
  });

  it("stops early once validation went green", async () => {
    const h = harness();
    await h.handlers.write_scad({ content: "a", message: "1" });
    await h.handlers.validate_mesh({});
    expect(h.budget.validatedGreen).toBe(true);
    const payload = envelope(await h.handlers.write_scad({ content: "b", message: "polish" }));
    expect(payload.error_code).toBe("PASS_BUDGET_EXHAUSTED");
    expect(payload.message).toMatch(/already green/i);
    expect(h.activity.hasRefusal("green")).toBe(true);
    expect(h.activity.hasRefusal("budget")).toBe(false);
  });

  it("surfaces a store failure mid-turn without consuming the whole turn", async () => {
    const scadCore = new MockScadCore({ failures: { writeScad: Object.assign(new Error("disk full"), {}) } });
    const h = harness(scadCore);
    const payload = envelope(await h.handlers.write_scad({ content: "a", message: "1" }));
    expect(payload).toMatchObject({ ok: false, error_code: "INTERNAL_ERROR", message: "disk full" });
    expect(payload.passes_remaining).toBe(1);
  });

  it("passes an implementation-supplied error_code straight through", async () => {
    const failure = Object.assign(new Error("openscad timed out after 60000ms"), { error_code: "TIMEOUT" });
    const h = harness(new MockScadCore({ failures: { writeScad: failure } }));
    expect(envelope(await h.handlers.write_scad({ content: "a", message: "1" })).error_code).toBe("TIMEOUT");
  });
});

describe("set_params", () => {
  it("reports unknown names and emits a snapshot", async () => {
    const h = harness();
    const payload = envelope(await h.handlers.set_params({ params: { size: 25, bogus: 1 } }));
    expect(setParamsResultSchema.parse(payload)).toBeTruthy();
    expect(payload.unknown_params).toEqual(["bogus"]);
    expect(payload.params.size).toBe(25);
    expect(h.events.filter((e) => e.type === "snapshot_created")).toHaveLength(1);
  });
});

describe("render_views", () => {
  it("emits a label block immediately before each image, in view order", async () => {
    const h = harness();
    const result = await h.handlers.render_views({ views: ["iso", "front"] });
    const payload = envelope(result);
    expect(renderViewsResultSchema.parse(payload)).toBeTruthy();

    expect(result.content).toHaveLength(5); // json + 2 x (label, image)
    expect(result.content[1]).toEqual({ type: "text", text: `${IMAGE_LABEL_PREFIX}iso` });
    expect(result.content[2]).toMatchObject({ type: "image", mimeType: TOOL_RESULT_IMAGE_MIME_TYPE });
    expect(result.content[3]).toEqual({ type: "text", text: `${IMAGE_LABEL_PREFIX}front` });
    expect(result.content[4]).toMatchObject({ type: "image" });
    expect(payload.views.map((v: any) => v.view)).toEqual(["iso", "front"]);
  });

  it("returns BARE base64 — never a data: URI", async () => {
    const h = harness();
    const result = await h.handlers.render_views({ views: ["iso"] });
    const image = result.content[2] as { data: string };
    expect(image.data.startsWith("data:")).toBe(false);
    expect(image.data).toBe("aGVsbG8=");
  });

  it("carries images on a PARTIAL failure and never sets isError", async () => {
    const scadCore = new MockScadCore({
      render: {
        ok: false,
        views: [
          renderedView("iso"),
          renderedView("section", { ok: false, path: null, bytes: null, stderr: "ERROR: CGAL error" })
        ],
        total_ms: 2000,
        error_code: "RENDER_FAILED",
        message: "The section pass failed."
      }
    });
    const h = harness(scadCore);
    const result = await h.handlers.render_views({ views: ["iso", "section"] });
    const payload = envelope(result);

    expect(result.isError).toBeUndefined();
    expect(payload.ok).toBe(false);
    expect(payload.error_code).toBe("RENDER_FAILED");
    expect(result.content.filter((b) => b.type === "image")).toHaveLength(1);
    expect(result.content[1]).toEqual({ type: "text", text: `${IMAGE_LABEL_PREFIX}iso` });
  });

  it("turns a render TIMEOUT into a labelled, image-less, non-error result", async () => {
    const failure = Object.assign(new Error("openscad timed out after 60000ms"), { error_code: "TIMEOUT" });
    const h = harness(new MockScadCore({ failures: { renderViews: failure } }));
    const result = await h.handlers.render_views({});
    const payload = envelope(result);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content.some((b) => b.type === "image")).toBe(false);
    expect(payload).toMatchObject({ ok: false, error_code: "TIMEOUT", views: [] });
    expect(payload.message).toMatch(/timed out/i);
  });

  it("carries filtered stderr on a thrown render when the implementation supplied it", async () => {
    const failure = Object.assign(new Error("openscad exited 1"), {
      error_code: "RENDER_FAILED",
      stderr: "Geometries in cache: 3\nERROR: CGAL error in CGALUtils::applyBinaryOperator"
    });
    const h = harness(new MockScadCore({ failures: { renderViews: failure } }));
    const payload = envelope(await h.handlers.render_views({}));
    expect(payload.stderr).toBe("ERROR: CGAL error in CGALUtils::applyBinaryOperator");
  });

  it("classifies a bare timeout Error even without an error_code", async () => {
    const h = harness(new MockScadCore({ failures: { renderViews: new Error("render timed out") } }));
    expect(envelope(await h.handlers.render_views({})).error_code).toBe("TIMEOUT");
  });

  it("filters OpenSCAD cache chatter out of stderr and returns null, not empty string", async () => {
    const scadCore = new MockScadCore({
      render: {
        ok: true,
        views: [
          renderedView("iso", { stderr: "Geometries in cache: 12\nCache size: 4 MB" }),
          renderedView("front", { stderr: "WARNING: Object may not be a valid 2-manifold" })
        ],
        total_ms: 1800
      }
    });
    const h = harness(scadCore);
    const payload = envelope(await h.handlers.render_views({ views: ["iso", "front"] }));
    expect(payload.views[0].stderr).toBeNull();
    expect(payload.views[1].stderr).toBe("WARNING: Object may not be a valid 2-manifold");
  });

  it("still returns the JSON when a PNG cannot be read", async () => {
    const scadCore = new MockScadCore({ failures: { readImageBase64: new Error("ENOENT") } });
    const h = harness(scadCore);
    const result = await h.handlers.render_views({ views: ["iso"] });
    expect(result.content).toHaveLength(1);
    expect(envelope(result).ok).toBe(true);
  });

  it("records render artifacts as URLs, never base64", async () => {
    const h = harness();
    await h.handlers.render_views({ views: ["iso"] });
    const recorded = h.activity.take("render_views")!;
    expect(recorded.artifacts).toHaveLength(1);
    expect(recorded.artifacts[0]).toMatchObject({ kind: "render", view: "iso" });
    expect(recorded.artifacts[0].url).not.toContain("aGVsbG8");
  });
});

describe("validate_mesh", () => {
  it("returns the gate NESTED under `gate`, next to the report", async () => {
    const h = harness();
    const payload = envelope(await h.handlers.validate_mesh({}));
    expect(validateMeshResultSchema.parse(payload)).toBeTruthy();
    expect(payload.gate).toMatchObject({ ok: true, badge: "green", failures: [], warnings: [] });
    expect(payload.report.manifold).toBe(true);
  });

  it("reports a red gate as ok:false and does NOT arm the early stop", async () => {
    const scadCore = new MockScadCore({
      validate: {
        report: healthyReport({ components: 2, genus: null }),
        gate: redGate(),
        export_ms: 700,
        validate_ms: 30
      }
    });
    const h = harness(scadCore);
    h.budget.openPass();
    const payload = envelope(await h.handlers.validate_mesh({}));
    expect(payload.ok).toBe(false);
    expect(payload.gate.failures[0].code).toBe("MULTIPLE_COMPONENTS");
    expect(h.budget.refusalReason()).toBeNull();
  });

  it("treats an amber gate as not-green, so the agent may still correct it", async () => {
    const scadCore = new MockScadCore({
      validate: {
        report: healthyReport({ genus: 2 }),
        gate: greenGate({ badge: "amber", warnings: ["genus 2: the part has handles or through-holes"] }),
        export_ms: 700,
        validate_ms: 30
      }
    });
    const h = harness(scadCore);
    h.budget.openPass();
    await h.handlers.validate_mesh({});
    expect(h.budget.validatedGreen).toBe(false);
  });

  it("maps an unreadable mesh onto MESH_PARSE_FAILED", async () => {
    const h = harness(new MockScadCore({ failures: { validateMesh: new Error("bad STL header") } }));
    expect(envelope(await h.handlers.validate_mesh({})).error_code).toBe("MESH_PARSE_FAILED");
  });
});

describe("export", () => {
  it("returns the full gate under `validation` on success", async () => {
    const h = harness();
    const payload = envelope(await h.handlers.export({ format: "3mf" }));
    expect(exportResultSchema.parse(payload)).toBeTruthy();
    expect(payload).toMatchObject({ ok: true, format: "3mf", file: "model.3mf", validation_overridden: false });
    expect(payload.validation.ok).toBe(true);
  });

  it("tells the agent WHICH gate refused it", async () => {
    const scadCore = new MockScadCore({
      exportResult: {
        ok: false,
        path: null,
        format: "stl",
        bytes: null,
        export_ms: 900,
        validation: redGate(),
        validation_overridden: false,
        error_code: "VALIDATION_FAILED",
        message: "Export refused: the mesh has 2 disconnected components."
      }
    });
    const h = harness(scadCore);
    const payload = envelope(await h.handlers.export({ format: "stl" }));
    expect(payload).toMatchObject({ ok: false, error_code: "VALIDATION_FAILED", file: null });
    expect(payload.validation.failures[0].code).toBe("MULTIPLE_COMPONENTS");
  });

  it("records an override", async () => {
    const scadCore = new MockScadCore({
      exportResult: {
        ok: true,
        path: "/tmp/scadforge/exports/model.stl",
        format: "stl",
        bytes: 1024,
        export_ms: 900,
        validation: redGate(),
        validation_overridden: true
      }
    });
    const h = harness(scadCore);
    const payload = envelope(await h.handlers.export({ format: "stl", allowValidationFailure: true }));
    expect(payload).toMatchObject({ ok: true, validation_overridden: true, file: "model.stl" });
  });

  it("maps a thrown export onto EXPORT_FAILED with a null validation", async () => {
    const h = harness(new MockScadCore({ failures: { exportModel: new Error("lib3mf refused the mesh") } }));
    const payload = envelope(await h.handlers.export({ format: "3mf" }));
    expect(payload).toMatchObject({ ok: false, error_code: "EXPORT_FAILED", validation: null, file: null });
  });
});

describe("library_lookup", () => {
  it("returns matches from the index seam", async () => {
    const h = harness();
    const payload = envelope(await h.handlers.library_lookup({ query: "cuboid" }));
    expect(libraryLookupResultSchema.parse(payload)).toBeTruthy();
    expect(payload.matches[0]).toMatchObject({ library: "BOSL2", name: "cuboid" });
  });

  it("reports LIBRARY_UNAVAILABLE when the index is missing", async () => {
    const h = harness(new MockScadCore(), new MockLibraryIndex([], new Error("index not built")));
    const payload = envelope(await h.handlers.library_lookup({ query: "screw" }));
    expect(payload).toMatchObject({ ok: false, error_code: "LIBRARY_UNAVAILABLE", matches: [] });
  });
});

describe("activity recording", () => {
  it("records one activity per call, in FIFO order per tool", async () => {
    const h = harness();
    await h.handlers.write_scad({ content: "a", message: "first" });
    h.budget.recordValidation(false);
    await h.handlers.write_scad({ content: "b", message: "second" });
    expect(h.activity.take("write_scad")?.summary).toBe("first");
    expect(h.activity.take("write_scad")?.summary).toBe("second");
    expect(h.activity.take("write_scad")).toBeUndefined();
  });

  it("rolls image counts up per pass", async () => {
    const h = harness();
    await h.handlers.write_scad({ content: "a", message: "first" });
    await h.handlers.render_views({ views: ["iso", "front"] });
    expect(h.activity.pass(1)).toMatchObject({ toolCalls: 2, images: 2 });
    expect(h.activity.images).toBe(2);
  });
});
