// FROZEN CONTRACT — ScadForge Issue #13. `packages/protocol/**` is
// Tech-Lead-owned; these assertions are part of the contract. Do NOT edit them
// inside a feature PR — changes require a Tech-Lead-approved contract-change
// issue, merged separately.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  API_BASE_PATH,
  API_ROUTES,
  EDITOR_ROUTES,
  EDITOR_SCHEMA_VERSION,
  ERROR_CODES,
  EXPORT_FORMATS,
  HTTP_STATUS_BY_ERROR_CODE,
  MCP_TOOL_NAME_PREFIX,
  PROJECT_LAYOUT,
  PROTOCOL_PACKAGE_NAME,
  SNAPSHOT_ID_PAD_WIDTH,
  SSE_CONTENT_TYPE,
  SSE_EVENT_TYPES,
  TOOL_NAMES,
  VIEW_NAMES
} from "./index.js";
import type {
  ApiError,
  ProjectManifest,
  ScadForgeErrorCode,
  SnapshotManifest,
  SnapshotOrigin,
  SseEvent,
  SseEventOf,
  SseEventType
} from "./index.js";

describe("@scadforge/protocol", () => {
  it("exports a package name stub", () => {
    expect(PROTOCOL_PACKAGE_NAME).toBe("@scadforge/protocol");
  });

});

describe("SSE event union", () => {
  it("is exactly the seven events frozen in PROJECT_CONTEXT.md", () => {
    expect([...SSE_EVENT_TYPES]).toEqual([
      "turn_started",
      "tool_call",
      "tool_result",
      "snapshot_created",
      "assistant_text",
      "turn_done",
      "error"
    ]);
  });

  it("streams as text/event-stream", () => {
    expect(SSE_CONTENT_TYPE).toBe("text/event-stream");
  });

  it("discriminates every member by `type`, with no member left unreachable", () => {
    // A switch that must stay exhaustive: adding a member to SseEvent without
    // adding a case here fails compilation on the `never` assignment.
    const classify = (event: SseEvent): SseEventType => {
      switch (event.type) {
        case "turn_started":
          return event.type;
        case "tool_call":
          return event.type;
        case "tool_result":
          return event.type;
        case "snapshot_created":
          return event.type;
        case "assistant_text":
          return event.type;
        case "turn_done":
          return event.type;
        case "error":
          return event.type;
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
    };

    const sample: SseEvent = {
      type: "assistant_text",
      turn_id: "t-1",
      text: "Added a 5mm chamfer to the top edge."
    };
    expect(classify(sample)).toBe("assistant_text");
  });

  it("narrows with SseEventOf", () => {
    const done: SseEventOf<"turn_done"> = {
      type: "turn_done",
      turn_id: "t-1",
      status: "completed",
      passes_used: 1,
      summary: "Bracket updated.",
      usage: null,
      duration_ms: 20_800
    };
    expect(done.passes_used).toBe(1);
  });

  it("carries render artifacts by URL, never as base64 (Spike 3 §6)", () => {
    const result: SseEventOf<"tool_result"> = {
      type: "tool_result",
      turn_id: "t-1",
      tool_call_id: "tc-1",
      name: "render_views",
      pass: 1,
      ok: true,
      error_code: null,
      summary: "4 views rendered",
      artifacts: [
        { kind: "render", view: "iso", url: "/api/projects/p1/snapshots/0002/views/iso.png", bytes: 8893 }
      ],
      duration_ms: 3729
    };
    // The artifact type has no `data` field at all — enforced structurally.
    expect(Object.keys(result.artifacts[0])).toEqual(["kind", "view", "url", "bytes"]);
    expect(result.artifacts[0].url.startsWith("data:")).toBe(false);
  });
});

describe("error vocabulary", () => {
  it("uses the frozen {error_code, message} shape", () => {
    const err: ApiError = { error_code: "PASS_BUDGET_EXHAUSTED", message: "Pass budget exhausted." };
    expect(Object.keys(err).sort()).toEqual(["error_code", "message"]);
  });

  it("includes every code Spike 3 §7.1 exercised or called for", () => {
    for (const code of [
      "PASS_BUDGET_EXHAUSTED",
      "SYNTAX_ERROR",
      "RENDER_FAILED",
      "EXPORT_FAILED",
      "MESH_PARSE_FAILED",
      "TIMEOUT"
    ] as const) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it("is SCREAMING_SNAKE_CASE with no duplicates", () => {
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("maps every code to an HTTP status", () => {
    for (const code of ERROR_CODES) {
      const status: number = HTTP_STATUS_BY_ERROR_CODE[code as ScadForgeErrorCode];
      expect(status).toBeGreaterThanOrEqual(400);
    }
    expect(Object.keys(HTTP_STATUS_BY_ERROR_CODE).length).toBe(ERROR_CODES.length);
  });
});

describe("snapshot / project model (SDP §8)", () => {
  it("names every file and directory of the .scadforge layout", () => {
    expect(PROJECT_LAYOUT.metaDir).toBe(".scadforge");
    expect(PROJECT_LAYOUT.modelFile).toBe("model.scad");
    expect(PROJECT_LAYOUT.paramsFile).toBe("params.json");
    expect(PROJECT_LAYOUT.projectFile).toBe("project.json");
    expect(PROJECT_LAYOUT.historyDir).toBe("history");
    expect(PROJECT_LAYOUT.exportsDir).toBe("exports");
    expect(PROJECT_LAYOUT.snapshot.viewsDir).toBe("views");
    expect(PROJECT_LAYOUT.snapshot.validationFile).toBe("validation.json");
    expect(PROJECT_LAYOUT.snapshot.diffFile).toBe("diff.patch");
  });

  it("accepts a fully-populated snapshot manifest, annotations included", () => {
    const snapshot: SnapshotManifest = {
      id: "0002",
      parent: "0001",
      timestamp: "2026-08-26T04:36:49.512Z",
      message: "Added missing loop handle on the side of the cup.",
      origin: "agent",
      pass: 1,
      files: {
        model_scad: "model.scad",
        params_json: "params.json",
        message_md: "message.md",
        validation_json: "validation.json",
        diff_patch: "diff.patch"
      },
      params: { wall: 4, smooth_fn: 48, label: "demo", flags: [true, false] },
      renders: [
        {
          view: "iso",
          file: "views/iso.png",
          url: "/api/projects/p1/snapshots/0002/views/iso.png",
          width: 1024,
          height: 768,
          bytes: 8893,
          render_ms: 656.8
        }
      ],
      validation: { badge: "green", manifold: true, components: 1, volume_mm3: 8000, warning_count: 0 },
      annotations: []
    };
    expect(snapshot.annotations).toEqual([]);
    expect(String(1).padStart(SNAPSHOT_ID_PAD_WIDTH, "0")).toBe("0001");
  });

  it("names every snapshot origin, including the S3 studio editor (Issue #104)", () => {
    // An exhaustive switch that must stay exhaustive. Adding a member to
    // SnapshotOrigin without a case here, or removing one, fails compilation.
    const describeOrigin = (origin: SnapshotOrigin): SnapshotOrigin => {
      switch (origin) {
        case "agent":
          return origin;
        case "manual":
          return origin;
        case "revert":
          return origin;
        case "initial":
          return origin;
        case "editor":
          return origin;
        default: {
          const unreachable: never = origin;
          return unreachable;
        }
      }
    };
    expect(describeOrigin("editor")).toBe("editor");
  });

  it("records the pinned OpenSCAD image on the project manifest", () => {
    const project: ProjectManifest = {
      schema_version: 1,
      id: "p1",
      name: "my-bracket",
      created: "2026-08-26T00:00:00.000Z",
      updated: "2026-08-26T04:36:49.512Z",
      openscad_image:
        "docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7",
      openscad_version: "2026.01.19 (git e43242666)",
      provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
      head: "0002"
    };
    expect(project.openscad_image).toContain("@sha256:");
  });
});

describe("REST surface", () => {
  it("mounts under /api with one route group per resource (CLAUDE.md rule 3)", () => {
    expect(API_BASE_PATH).toBe("/api");
    expect(Object.keys(API_ROUTES).sort()).toEqual([
      "build",
      "chat",
      "exports",
      "health",
      "params",
      "projects",
      "renders",
      "snapshots",
      "source"
    ]);
  });

  it("mounts the #54 studio source/build routes", () => {
    expect(API_ROUTES.source.get).toBe("/projects/:projectId/source");
    expect(API_ROUTES.source.preflight).toBe("/projects/:projectId/source/preflight");
    expect(API_ROUTES.source.update).toBe("/projects/:projectId/source");
    expect(API_ROUTES.build.create).toBe("/projects/:projectId/build");
  });

  it("uses :projectId / :snapshotId path params consistently", () => {
    const paths = [
      API_ROUTES.projects.get,
      API_ROUTES.chat.turn,
      API_ROUTES.snapshots.get,
      API_ROUTES.snapshots.revert,
      API_ROUTES.renders.create,
      API_ROUTES.params.update,
      API_ROUTES.exports.create
    ];
    for (const path of paths) expect(path.startsWith("/projects/:projectId")).toBe(true);
    expect(API_ROUTES.snapshots.get).toBe("/projects/:projectId/snapshots/:snapshotId");
  });

  it("mounts the S3-A editor routes under a separate EDITOR_ROUTES constant", () => {
    // Wire-and-recovery §"Exact additive protocol proposal": EDITOR_ROUTES is a
    // separate exported constant; API_ROUTES is NOT silently mutated.
    expect(EDITOR_ROUTES.get).toBe("/projects/:projectId/editor");
    expect(EDITOR_ROUTES.verify).toBe("/projects/:projectId/editor/verify");
    expect(EDITOR_ROUTES.commands).toBe("/projects/:projectId/editor/commands");
    expect(EDITOR_ROUTES.operation).toBe(
      "/projects/:projectId/editor/operations/:operationId"
    );
    expect(Object.keys(API_ROUTES).sort()).not.toContain("editor");
  });

  it("freezes the editor schema version at 1 (Issue #68 / S3-A)", () => {
    expect(EDITOR_SCHEMA_VERSION).toBe(1);
  });
});

describe("wire vocabulary mirrors", () => {
  it("lists the five fixed views and three export formats", () => {
    expect([...VIEW_NAMES]).toEqual(["iso", "front", "top", "right", "section"]);
    expect([...EXPORT_FORMATS]).toEqual(["3mf", "stl", "off"]);
  });

  it("lists the seven agent tools", () => {
    expect([...TOOL_NAMES]).toEqual([
      "read_project",
      "write_scad",
      "set_params",
      "render_views",
      "validate_mesh",
      "export",
      "library_lookup"
    ]);
  });

  it("keeps the Claude-Code MCP prefix out of protocol names (Spike 3 §6)", () => {
    expect(MCP_TOOL_NAME_PREFIX).toBe("mcp__scadforge__");
    for (const name of TOOL_NAMES) expect(name.startsWith(MCP_TOOL_NAME_PREFIX)).toBe(false);
  });
});
