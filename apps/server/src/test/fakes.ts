// SPDX-License-Identifier: Apache-2.0
//
// In-memory fakes for `ScadCoreApi` and `AgentProvider`, used only by this
// package's own route tests. Not a production implementation of either
// interface — Issue #14 / #16 own those; Issue #20 wires them in via
// `AppDeps` (see app.ts). Kept intentionally small: just enough behavior for
// route tests to exercise real request/response/error-mapping paths.

import { randomUUID } from "node:crypto";
import { PROJECT_LAYOUT, SNAPSHOT_ID_PAD_WIDTH } from "@scadforge/protocol";
import type {
  CreateProjectRequest,
  EditorProofResponse,
  EditorVerifyRequest,
  ExportRequest,
  ExportResponse,
  ListProjectsResponse,
  ParamValues,
  ParamsResponse,
  ParamsUpdateRequest,
  ProjectManifest,
  ProjectResponse,
  RenderViewsRequest,
  RenderViewsResponse,
  RevertRequest,
  SnapshotDiffResponse,
  SnapshotManifest,
  SnapshotResponse,
  SourcePreflightRequest,
  SourcePreflightResponse,
  SourceResponse,
  SourceUpdateRequest,
  BuildRequest,
  BuildResponse,
  ViewName
} from "@scadforge/protocol";
import { RouteError } from "../services/errors.js";
import type { RenderFile, ScadCoreApi } from "../services/scad-core-api.js";
import type { AgentEventSink, AgentProvider, AgentTurnInput } from "../services/agent-provider.js";

interface FakeProjectState {
  manifest: ProjectManifest;
  scad: string;
  params: ParamValues;
  snapshots: SnapshotManifest[];
}

function padSnapshotId(n: number): string {
  return String(n).padStart(SNAPSHOT_ID_PAD_WIDTH, "0");
}

function makeInitialSnapshot(_scad: string): SnapshotManifest {
  const now = new Date().toISOString();
  return {
    id: padSnapshotId(1),
    parent: null,
    timestamp: now,
    message: "Initial snapshot",
    origin: "initial",
    pass: null,
    files: {
      model_scad: PROJECT_LAYOUT.snapshot.modelFile,
      params_json: PROJECT_LAYOUT.snapshot.paramsFile,
      message_md: PROJECT_LAYOUT.snapshot.messageFile,
      validation_json: null,
      diff_patch: null
    },
    params: {},
    renders: [],
    validation: null,
    annotations: []
  };
}

/** Creates a fresh in-memory `ScadCoreApi` fake — one instance per test. */
export function createFakeScadCoreApi(): ScadCoreApi & { _projects: Map<string, FakeProjectState> } {
  const projects = new Map<string, FakeProjectState>();
  let nextProjectSeq = 1;

  function requireProject(projectId: string): FakeProjectState {
    const project = projects.get(projectId);
    if (!project) {
      throw new RouteError("PROJECT_NOT_FOUND", `No project with id "${projectId}".`);
    }
    return project;
  }

  function requireSnapshot(projectId: string, snapshotId: string): { project: FakeProjectState; snapshot: SnapshotManifest } {
    const project = requireProject(projectId);
    const snapshot = project.snapshots.find((s) => s.id === snapshotId);
    if (!snapshot) {
      throw new RouteError("SNAPSHOT_NOT_FOUND", `No snapshot "${snapshotId}" in project "${projectId}".`);
    }
    return { project, snapshot };
  }

  const api: ScadCoreApi & { _projects: Map<string, FakeProjectState> } = {
    _projects: projects,

    async createProject(input: CreateProjectRequest): Promise<ProjectResponse> {
      const id = `proj-${nextProjectSeq++}`;
      const now = new Date().toISOString();
      const scad = input.scad ?? "";
      const initial = makeInitialSnapshot(scad);
      const manifest: ProjectManifest = {
        schema_version: 1,
        id,
        name: input.name,
        created: now,
        updated: now,
        openscad_image: "docker.io/openscad/openscad@sha256:fake",
        openscad_version: "fake-test-version",
        provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
        head: initial.id
      };
      const state: FakeProjectState = { manifest, scad, params: {}, snapshots: [initial] };
      projects.set(id, state);
      return { project: manifest, scad: state.scad, params: state.params, head: initial };
    },

    async getProject(projectId: string): Promise<ProjectResponse> {
      const project = requireProject(projectId);
      const head = project.snapshots.at(-1) ?? null;
      return { project: project.manifest, scad: project.scad, params: project.params, head };
    },

    async listProjects(): Promise<ListProjectsResponse> {
      return { projects: Array.from(projects.values()).map((p) => p.manifest) };
    },

    async listSnapshots(projectId: string): Promise<SnapshotManifest[]> {
      const project = requireProject(projectId);
      return [...project.snapshots].reverse();
    },

    async getSnapshot(projectId: string, snapshotId: string): Promise<SnapshotResponse> {
      const { project, snapshot } = requireSnapshot(projectId, snapshotId);
      return { snapshot, scad: project.scad };
    },

    async getSnapshotDiff(projectId: string, snapshotId: string): Promise<SnapshotDiffResponse> {
      const { snapshot } = requireSnapshot(projectId, snapshotId);
      return { id: snapshot.id, parent: snapshot.parent, diff: "" };
    },

    async revertSnapshot(projectId: string, snapshotId: string, request: RevertRequest): Promise<SnapshotResponse> {
      const { project, snapshot } = requireSnapshot(projectId, snapshotId);
      // Test-only escape hatch (mirrors runExport's `__forceValidationFailure`
      // above): lets a route test exercise the M1 store concurrency policy's
      // typed CONFLICT -> 409 mapping for revert without needing real
      // cross-process filesystem contention.
      if (request.message === "__forceConflict__") {
        throw new RouteError("CONFLICT", "could not allocate a snapshot id (fake: forced conflict).");
      }
      const newId = padSnapshotId(project.snapshots.length + 1);
      const reverted: SnapshotManifest = {
        ...snapshot,
        id: newId,
        parent: project.snapshots.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        message: request.message ?? `Reverted to ${snapshot.id}`,
        origin: "revert"
      };
      project.snapshots.push(reverted);
      project.manifest.head = newId;
      return { snapshot: reverted, scad: project.scad };
    },

    async getSnapshotRenderFile(projectId: string, snapshotId: string, view: string): Promise<RenderFile | null> {
      const project = projects.get(projectId);
      if (!project) return null;
      const snapshot = project.snapshots.find((s) => s.id === snapshotId);
      if (!snapshot) return null;
      const render = snapshot.renders.find((r) => r.view === view);
      if (!render) return null;
      const data = new TextEncoder().encode(`fake-png:${projectId}:${snapshotId}:${view}`);
      return { data, contentType: "image/png", bytes: data.byteLength };
    },

    async getSnapshotMeshFile(projectId: string, snapshotId: string): Promise<RenderFile | null> {
      const project = projects.get(projectId);
      if (!project) return null;
      const snapshot = project.snapshots.find((s) => s.id === snapshotId);
      if (!snapshot) return null;
      // Mirrors the real rule (scad-core `attachments.ts`): a mesh exists iff
      // something validated that snapshot, since validation is what renders
      // the STL. A never-validated snapshot has no mesh and yields a 404.
      if (!snapshot.validation) return null;
      const data = new TextEncoder().encode(`fake-stl:${projectId}:${snapshotId}`);
      return { data, contentType: "model/stl", bytes: data.byteLength };
    },

    async getParams(projectId: string): Promise<ParamsResponse> {
      const project = requireProject(projectId);
      return {
        title: project.manifest.name,
        parameters: [{ name: "pipe_d", type: "number", initial: 32, min: 1, max: 200 }],
        values: project.params
      };
    },

    async updateParams(projectId: string, request: ParamsUpdateRequest): Promise<ParamsResponse> {
      const project = requireProject(projectId);
      project.params = { ...project.params, ...request.values };
      return {
        title: project.manifest.name,
        parameters: [{ name: "pipe_d", type: "number", initial: 32, min: 1, max: 200 }],
        values: project.params
      };
    },

    async getSource(projectId: string): Promise<SourceResponse> {
      const project = requireProject(projectId);
      const head = project.snapshots.at(-1) ?? null;
      return { project: project.manifest, scad: project.scad, params: project.params, head, revision: "fake-revision" };
    },

    async preflightSource(projectId: string, request: SourcePreflightRequest): Promise<SourcePreflightResponse> {
      const project = requireProject(projectId);
      if (request.base_revision === "__stale__") {
        throw new RouteError("CONFLICT", "stale revision (fake: forced conflict).");
      }
      if (request.scad === "__invalid__") {
        return {
          revision: "fake-revision",
          syntax_ok: false,
          diagnostics: "ERROR: Parser error: fake invalid source.",
          parameters: [],
          retained_params: {},
          removed_params: []
        };
      }
      return {
        revision: "fake-revision",
        syntax_ok: true,
        diagnostics: null,
        parameters: [{ name: "pipe_d", type: "number", initial: 32, min: 1, max: 200 }],
        retained_params: project.params,
        removed_params: []
      };
    },

    async updateSource(projectId: string, request: SourceUpdateRequest): Promise<SourceResponse> {
      const project = requireProject(projectId);
      if (request.base_revision === "__stale__") {
        throw new RouteError("CONFLICT", "stale revision (fake: forced conflict).");
      }
      if (request.scad === "__invalid__") {
        throw new RouteError("VALIDATION_FAILED", "Source does not parse (fake).");
      }
      project.scad = request.scad;
      return {
        project: project.manifest,
        scad: project.scad,
        params: project.params,
        head: project.snapshots.at(-1) ?? null,
        revision: "fake-revision"
      };
    },

    async build(projectId: string, request: BuildRequest): Promise<BuildResponse> {
      const project = requireProject(projectId);
      if (request.base_revision === "__stale__") {
        throw new RouteError("CONFLICT", "stale revision (fake: forced conflict).");
      }
      const head = project.snapshots.at(-1);
      if (!head) throw new RouteError("INTERNAL_ERROR", "No snapshot to build.");
      return { snapshot: head };
    },

    async renderViews(projectId: string, request: RenderViewsRequest): Promise<RenderViewsResponse> {
      requireProject(projectId);
      const views: ViewName[] = request.views ?? ["iso", "front", "right", "section"];
      return {
        ok: true,
        views: views.map((view) => ({
          view,
          ok: true,
          url: `/api/projects/${projectId}/snapshots/latest/views/${view}`,
          width: request.imgsize?.[0] ?? 1024,
          height: request.imgsize?.[1] ?? 768,
          bytes: 1234,
          render_ms: 10,
          stderr: null
        })),
        total_ms: 10 * views.length,
        snapshot: null
      };
    },

    async runExport(projectId: string, request: ExportRequest): Promise<ExportResponse> {
      requireProject(projectId);
      if (!request.allow_validation_failure) {
        // Fake gate: always green unless the caller signals otherwise via
        // `params.__forceValidationFailure` (test-only escape hatch).
        const forceFailure = request.params?.__forceValidationFailure === true;
        if (forceFailure) {
          throw new RouteError("VALIDATION_FAILED", "Mesh failed validation (fake: forced failure).");
        }
      }
      return {
        export: {
          snapshot: padSnapshotId(1),
          format: request.format,
          file: `fake.${request.format}`,
          url: `/api/projects/${projectId}/exports/fake.${request.format}`,
          bytes: 4321,
          timestamp: new Date().toISOString(),
          validation_overridden: request.allow_validation_failure ?? false
        },
        validation: {
          badge: "green",
          manifold: true,
          components: 1,
          volume_mm3: 100,
          warning_count: 0
        }
      };
    },

    async getExportFile(projectId: string, file: string): Promise<RenderFile | null> {
      if (!projects.has(projectId)) return null;
      if (file !== "fake.3mf" && !file.startsWith("fake.")) return null;
      const data = new TextEncoder().encode(`fake-export:${projectId}:${file}`);
      return { data, contentType: "model/3mf", bytes: data.byteLength };
    },

    // ── editor (S3-B B5, Issue #91) ───────────────────────────────────────
    //
    // `EditorVerifyRequest.baseEditorRevision` and `command.featureId` are
    // strictly validated (64-hex / UUID) by `parseEditorVerifyRequest`
    // before this fake ever sees them, so the `"__stale__"`-style string
    // sentinels the other fakes above use would never reach here (the route
    // would already have rejected them as INVALID_REQUEST). Route tests
    // that want a specific error code instead pick it via a reserved
    // `set-value` sentinel `value` — still an ordinary finite number, so it
    // survives the real parser.
    async verifyEditorCommand(projectId: string, request: EditorVerifyRequest): Promise<EditorProofResponse> {
      requireProject(projectId);

      if (request.baseEditorRevision === FAKE_STALE_REVISION) {
        throw new RouteError("CONFLICT", "The base editor revision is stale (fake: forced conflict).");
      }

      if (request.command.kind === "set-value") {
        if (request.command.value === FAKE_VALIDATION_FAILED_VALUE) {
          throw new RouteError("VALIDATION_FAILED", "The declared binding does not hold for this candidate (fake: forced refusal).");
        }
        if (request.command.value === FAKE_RENDER_FAILED_VALUE) {
          throw new RouteError("RENDER_FAILED", "The OpenSCAD engine failed to render the sample (fake: forced failure).");
        }
        if (request.command.value === FAKE_TIMEOUT_VALUE) {
          throw new RouteError("TIMEOUT", "The render timed out (fake: forced timeout).");
        }
      }

      return {
        version: 1,
        proofId: randomUUID(),
        commandDigest: "a".repeat(64),
        baseEditorRevision: request.baseEditorRevision,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      };
    }
  };

  return api;
}

/** Reserved sentinel values `verifyEditorCommand`'s fake checks for, exported so route tests can build requests that trigger each error code deliberately (see that method's own comment for why these are numbers/hex, not the `"__stale__"`-style string sentinels used elsewhere in this file). */
export const FAKE_STALE_REVISION = "0".repeat(64);
export const FAKE_VALIDATION_FAILED_VALUE = -9999;
export const FAKE_RENDER_FAILED_VALUE = -9998;
export const FAKE_TIMEOUT_VALUE = -9997;

/** A single scripted step of a fake agent turn. */
export type ScriptedEvent = (turnId: string) => Parameters<AgentEventSink>[0];

/**
 * A fake `AgentProvider` that replays a fixed script of events (in order) for
 * every `runTurn` call, or throws when `script` itself is a function that
 * throws — used by chat.test.ts's mid-stream-failure counterexample.
 */
export function createScriptedAgentProvider(
  script: ScriptedEvent[] | ((input: AgentTurnInput) => Promise<void> | void)
): AgentProvider {
  return {
    async runTurn(input: AgentTurnInput, onEvent: AgentEventSink): Promise<void> {
      if (typeof script === "function") {
        await script(input);
        return;
      }
      for (const step of script) {
        onEvent(step(input.turnId));
      }
    }
  };
}
