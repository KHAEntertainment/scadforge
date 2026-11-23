// SPDX-License-Identifier: Apache-2.0

// S3-C C4 — TEST-ONLY in-memory server double for the Edit surface's UI
// integration tests (Tech-Lead condition 5). NOT the production store: no
// filesystem, no locks, no `apps/server`, no OpenSCAD. The real-server suite
// is C5's.
//
// What is real (imported, unmodified):
//  - `@scadforge/scad-core`: `applyEditorCommand` (set-value incl. the no-op
//    refusal and the proven-params cross-check), `applyEditorTraversal`
//    (exact-inverse + precondition checks for undo/redo), `editorRevision`,
//    `computeSourceRevision`, `sidecarDigest`, `sourceFingerprint`,
//    `commandDigest`, `requestDigest`;
//  - `@scadforge/protocol`: `parseEditorVerifyRequest` and
//    `parseEditorCommitRequest` validate every editor request body.
// What is hand-written here: HTTP routing; operation claims and idempotent
// replay by operation id; the proof (no geometry probe — a proof is issued
// for any command whose candidate params can be computed); snapshots; the
// non-editor routes the App needs; and fault/hold hooks for tests.

import {
  API_ROUTES,
  EDITOR_ROUTES,
  parseEditorCommitRequest,
  parseEditorVerifyRequest,
  type ApiError,
  type EditorCommand,
  type EditorDocument,
  type EditorEligibility,
  type EditorFeature,
  type EditorOperationResponse,
  type EditorProofResponse,
  type EditorReceipt,
  type EditorSidecarStatus,
  type ParamDefinitionWire,
  type ParamValues,
  type ProjectManifest,
  type SnapshotManifest
} from "@scadforge/protocol";
import {
  applyEditorCommand,
  applyEditorTraversal,
  commandDigest,
  computeSourceRevision,
  editorRevision,
  requestDigest,
  sidecarDigest,
  sourceFingerprint,
  type AcceptedOperationRecord,
  type EditorCommandResult
} from "@scadforge/scad-core";

export interface FakeProjectSeed {
  id: string;
  scad?: string;
  values?: ParamValues;
  parameters?: ParamDefinitionWire[];
  /** Features without the derived fields; `projectId`, `sourceFingerprint` and `createdAtRevision` are filled in. */
  features?: Array<Pick<EditorFeature, "featureId" | "label" | "binding"> & Partial<EditorFeature>>;
  sidecarStatus?: EditorSidecarStatus;
  eligibility?: EditorEligibility[];
}

interface Claim {
  requestDigest: string;
  status: number;
  body: unknown;
  response: EditorOperationResponse;
  accepted: AcceptedOperationRecord | null;
}

interface ProjectState {
  id: string;
  scad: string;
  values: ParamValues;
  parameters: ParamDefinitionWire[];
  features: EditorFeature[];
  sidecarStatus: EditorSidecarStatus;
  eligibility: EditorEligibility[];
  /** Newest first. */
  snapshots: SnapshotManifest[];
  claims: Map<string, Claim>;
  proofs: Map<string, { commandDigest: string; baseEditorRevision: string; candidateParams: ParamValues | null }>;
}

/** A hold: the request waits until `release()` is called. */
export interface Hold {
  release(): void;
  /** Resolves once the held request has arrived. */
  arrived: Promise<void>;
}

type Route = "editor-get" | "verify" | "commit" | "operation" | "params-update" | "chat" | "source-get";

const ZERO_REV = "0".repeat(64);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(status: number, error_code: ApiError["error_code"], message: string): Response {
  return json(status, { error_code, message });
}

function project(id: string): ProjectManifest {
  return {
    schema_version: 1,
    id,
    name: id,
    created: "2026-11-01T00:00:00.000Z",
    updated: "2026-11-01T00:00:00.000Z",
    openscad_image: "openscad@sha256:abc",
    openscad_version: "2026.01.19",
    provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
    head: null
  } as ProjectManifest;
}

export class FakeEditorServer {
  readonly projects = new Map<string, ProjectState>();
  /** Every request, in order (`METHOD path`). */
  readonly log: string[] = [];
  /** Accepted editor commits (snapshots created by `/editor/commands`). */
  acceptedCommits = 0;
  /** Commit POSTs received, by operation id. */
  readonly commitPosts: Array<{ projectId: string; operationId: string }> = [];
  /** Queued faults for the next commit POSTs: `lost-before` = 503 and nothing committed. */
  readonly commitFaults: Array<"lost-before"> = [];
  /** Called after an editor commit is accepted, before its response is sent. */
  afterCommit: ((projectId: string) => void) | null = null;
  /** The next GET /editor for these project ids answers 500. */
  readonly failEditorGet = new Set<string>();
  /** Build POSTs received, with the base revision each sent and whether it was current. */
  readonly buildPosts: Array<{ projectId: string; baseRevision: string; current: boolean }> = [];
  /**
   * When set, the next chat POST is a fast turn: the agent writes these values,
   * then `turn_started` and `turn_done` arrive in ONE chunk (one render), and
   * the stream closes. Cleared after use.
   */
  fastChat: { values: ParamValues } | null = null;

  private readonly holds = new Map<Route, Array<{ gate: Promise<void>; arrive: () => void }>>();
  private proofCounter = 0;
  private turnCounter = 0;
  private snapshotCounter = 0;
  private chatController: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(seeds: FakeProjectSeed[]) {
    for (const seed of seeds) this.addProject(seed);
  }

  addProject(seed: FakeProjectSeed): void {
    const scad = seed.scad ?? "cube([wall, 10, 10]);";
    const fingerprint = sourceFingerprint(scad);
    const state: ProjectState = {
      id: seed.id,
      scad,
      values: { ...(seed.values ?? { wall: 2 }) },
      parameters: seed.parameters ?? [{ name: "wall", type: "number", initial: 2, min: 0.5, max: 20, step: 0.5 }],
      features: (seed.features ?? []).map((feature) => ({
        projectId: seed.id,
        sourceFingerprint: fingerprint,
        createdAtRevision: ZERO_REV,
        bindingVersion: 1,
        provenance: { kind: "manual" },
        ...feature
      })),
      sidecarStatus: seed.sidecarStatus ?? "ready",
      eligibility: seed.eligibility ?? [],
      snapshots: [],
      claims: new Map(),
      proofs: new Map()
    };
    this.projects.set(seed.id, state);
    this.addSnapshot(state, "seed");
  }

  /** Holds the next request on `route` until released. */
  hold(route: Route): Hold {
    let release!: () => void;
    let arrive!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const queue = this.holds.get(route) ?? [];
    queue.push({ gate, arrive });
    this.holds.set(route, queue);
    return { release, arrived };
  }

  editorRevision(projectId: string): string {
    const state = this.state(projectId);
    return editorRevision(this.sourceRevision(state), sidecarDigest({ version: 1, features: state.features }));
  }

  document(projectId: string): EditorDocument {
    const state = this.state(projectId);
    const sourceRevision = this.sourceRevision(state);
    return {
      version: 1,
      projectId: state.id,
      head: state.snapshots[0]?.id ?? null,
      sourceRevision,
      sourceFingerprint: sourceFingerprint(state.scad),
      editorRevision: this.editorRevision(projectId),
      scad: state.scad,
      parameters: state.parameters,
      values: { ...state.values },
      sidecar: { version: 1, features: [...state.features].sort((a, b) => (a.featureId < b.featureId ? -1 : 1)) },
      sidecarStatus: state.sidecarStatus,
      eligibility: state.eligibility
    };
  }

  values(projectId: string): ParamValues {
    return { ...this.state(projectId).values };
  }

  /** Another tab or process writes params (no signal reaches this tab). */
  externalWrite(projectId: string, values: ParamValues): void {
    const state = this.state(projectId);
    state.values = { ...state.values, ...values };
    this.addSnapshot(state, "external write");
  }

  /** Opens nothing by itself: the next chat POST streams `turn_started` and stays open until `dropChat()`. */
  dropChat(): void {
    this.chatController?.close();
    this.chatController = null;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api/, "");
    this.log.push(`${method} ${path}`);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;

    if (path === API_ROUTES.health) return json(200, { ok: true, version: "0.0.0", openscad_image: "openscad@sha256:abc", openscad_version: "2026.01.19" });
    if (path === API_ROUTES.projects.list && method === "GET") return json(200, { projects: [...this.projects.keys()].map(project) });

    const match = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return apiError(404, "NOT_FOUND", `unhandled: ${method} ${path}`);
    const projectId = decodeURIComponent(match[1]);
    const rest = match[2] ?? "";
    const state = this.projects.get(projectId);
    if (!state) return apiError(404, "NOT_FOUND", `no project ${projectId}`);

    if (rest === "" && method === "GET") return json(200, this.projectResponse(state));
    if (rest === "/snapshots" && method === "GET") return json(200, { snapshots: state.snapshots });
    if (/^\/snapshots\/[^/]+\/mesh$/.test(rest)) return new Response(null, { status: 404 });
    const diff = /^\/snapshots\/([^/]+)\/diff$/.exec(rest);
    if (diff) return json(200, { id: diff[1], parent: null, diff: "" });
    const revert = /^\/snapshots\/([^/]+)\/revert$/.exec(rest);
    if (revert && method === "POST") return this.revert(state, revert[1]);
    const snapshot = /^\/snapshots\/([^/]+)$/.exec(rest);
    if (snapshot) {
      const found = state.snapshots.find((s) => s.id === snapshot[1]);
      return found ? json(200, { snapshot: found, scad: state.scad }) : apiError(404, "NOT_FOUND", "no snapshot");
    }
    if (rest === "/params" && method === "GET") return json(200, { title: state.id, parameters: state.parameters, values: state.values });
    if (rest === "/params" && method === "PUT") {
      await this.passHold("params-update");
      const update = body as { values: ParamValues };
      state.values = { ...state.values, ...update.values };
      this.addSnapshot(state, "params");
      return json(200, { title: state.id, parameters: state.parameters, values: state.values });
    }
    if (rest === "/source" && method === "GET") {
      await this.passHold("source-get");
      return json(200, { ...this.projectResponse(state), revision: this.sourceRevision(state) });
    }
    if (rest === "/export" && method === "POST") {
      return json(200, {
        export: { snapshot: state.snapshots[0].id, format: "3mf", file: `${state.id}.3mf`, url: `/api/projects/${state.id}/exports/${state.id}.3mf`, bytes: 3, timestamp: "2026-11-01T00:00:00.000Z" },
        validation: null
      });
    }
    if (rest.startsWith("/exports/")) return new Response(new Blob(["3mf"]), { status: 200 });
    if (rest === "/build" && method === "POST") {
      const baseRevision = (body as { base_revision: string }).base_revision;
      const current = baseRevision === this.sourceRevision(state);
      this.buildPosts.push({ projectId: state.id, baseRevision, current });
      return current ? json(200, { snapshot: state.snapshots[0] }) : apiError(409, "CONFLICT", "The source changed since this revision; reload and build again.");
    }
    if (rest === "/chat" && method === "POST") return this.chat(state);

    // ── editor routes ────────────────────────────────────────────────────
    if (`/projects/:projectId${rest}` === EDITOR_ROUTES.get && method === "GET") {
      await this.passHold("editor-get");
      if (this.failEditorGet.delete(projectId)) return apiError(500, "INTERNAL_ERROR", "editor read failed (test fault)");
      return json(200, this.document(projectId));
    }
    if (`/projects/:projectId${rest}` === EDITOR_ROUTES.verify && method === "POST") {
      await this.passHold("verify");
      return this.verify(state, body);
    }
    if (`/projects/:projectId${rest}` === EDITOR_ROUTES.commands && method === "POST") {
      await this.passHold("commit");
      return this.commit(state, body);
    }
    const operation = /^\/editor\/operations\/([^/]+)$/.exec(rest);
    if (operation && method === "GET") {
      await this.passHold("operation");
      const claim = state.claims.get(operation[1]);
      return json(200, claim ? claim.response : { version: 1, state: "definitely_not_committed", requestDigest: null, reason: "unclaimed", error: null });
    }
    return apiError(404, "NOT_FOUND", `unhandled: ${method} ${path}`);
  };

  // ── internals ──────────────────────────────────────────────────────────

  private state(projectId: string): ProjectState {
    const state = this.projects.get(projectId);
    if (!state) throw new Error(`FakeEditorServer: no project ${projectId}`);
    return state;
  }

  private sourceRevision(state: ProjectState): string {
    return computeSourceRevision(state.snapshots[0]?.id ?? null, state.scad, state.values);
  }

  private projectResponse(state: ProjectState) {
    return { project: { ...project(state.id), head: state.snapshots[0]?.id ?? null }, scad: state.scad, params: state.values, head: state.snapshots[0] ?? null };
  }

  private addSnapshot(state: ProjectState, message: string): SnapshotManifest {
    this.snapshotCounter += 1;
    const id = String(this.snapshotCounter).padStart(4, "0");
    const manifest = {
      id,
      parent: state.snapshots[0]?.id ?? null,
      timestamp: "2026-11-01T00:00:00.000Z",
      message,
      origin: "user",
      pass: null,
      files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
      params: { ...state.values },
      renders: [],
      validation: null,
      annotations: []
    } as unknown as SnapshotManifest;
    state.snapshots.unshift(manifest);
    return manifest;
  }

  private async passHold(route: Route): Promise<void> {
    const queue = this.holds.get(route);
    const next = queue?.shift();
    if (!next) return;
    next.arrive();
    await next.gate;
  }

  private candidateParams(state: ProjectState, command: EditorCommand): ParamValues | null {
    if (command.kind !== "set-value") return null;
    const feature = state.features.find((f) => f.featureId === command.featureId && f.bindingVersion === command.bindingVersion);
    return feature ? { ...state.values, [feature.binding.parameter]: command.value } : null;
  }

  private apply(state: ProjectState, request: { baseEditorRevision: string; command: EditorCommand; intent: string; traversal: { operationId: string; direction: "undo" | "redo" } | null }, proven: ParamValues | null): EditorCommandResult {
    if (request.intent === "undo" || request.intent === "redo") {
      const original = request.traversal ? state.claims.get(request.traversal.operationId)?.accepted ?? null : null;
      return applyEditorTraversal({
        intent: request.intent,
        traversal: request.traversal!,
        submittedCommand: request.command,
        currentFeatures: state.features,
        currentParams: state.values,
        originalAccepted: original
      });
    }
    return applyEditorCommand({
      projectId: state.id,
      baseEditorRevision: request.baseEditorRevision,
      sourceFingerprint: sourceFingerprint(state.scad),
      command: request.command,
      currentFeatures: state.features,
      currentParams: state.values,
      provenCandidateParams: proven
    });
  }

  private verify(state: ProjectState, body: unknown): Response {
    const request = parseEditorVerifyRequest(body);
    if (request.baseEditorRevision !== this.editorRevision(state.id)) return apiError(409, "CONFLICT", "The project changed; refresh and re-verify.");
    const candidate = request.intent === "undo" || request.intent === "redo" ? null : this.candidateParams(state, request.command);
    const result = this.apply(state, request, candidate);
    if (result.status === "refused") return apiError(result.code === "CONFLICT" ? 409 : 422, result.code, result.message);
    this.proofCounter += 1;
    const proof: EditorProofResponse = {
      version: 1,
      proofId: crypto.randomUUID(),
      commandDigest: commandDigest({ ...request, projectId: state.id }),
      baseEditorRevision: request.baseEditorRevision,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    };
    state.proofs.set(proof.proofId, { commandDigest: proof.commandDigest, baseEditorRevision: proof.baseEditorRevision, candidateParams: result.nextParams });
    return json(200, proof);
  }

  private commit(state: ProjectState, body: unknown): Response {
    const request = parseEditorCommitRequest(body);
    this.commitPosts.push({ projectId: state.id, operationId: request.operationId });
    const digest = requestDigest({ ...request, projectId: state.id });
    const existing = state.claims.get(request.operationId);
    if (existing) {
      if (existing.requestDigest !== digest) return apiError(409, "CONFLICT", "Operation id reused with a different request.");
      return json(existing.status, existing.body);
    }
    if (this.commitFaults[0] === "lost-before") {
      this.commitFaults.shift();
      return apiError(503, "INTERNAL_ERROR", "transport lost before commit (test fault)");
    }
    const reject = (status: number, code: ApiError["error_code"], message: string): Response => {
      const error = { error_code: code, message };
      state.claims.set(request.operationId, {
        requestDigest: digest,
        status,
        body: error,
        response: { version: 1, state: "definitely_not_committed", requestDigest: digest, reason: "rejected", error },
        accepted: null
      });
      return json(status, error);
    };
    const proof = state.proofs.get(request.proofId);
    if (!proof || proof.commandDigest !== commandDigest({ ...request, projectId: state.id })) {
      return reject(422, "VALIDATION_FAILED", "The proof for this command is missing or does not match; re-verify and retry.");
    }
    if (request.baseEditorRevision !== this.editorRevision(state.id)) return reject(409, "CONFLICT", "The project changed; refresh and re-verify.");
    const result = this.apply(state, request, proof.candidateParams);
    if (result.status === "refused") return reject(result.code === "CONFLICT" ? 409 : 422, result.code, result.message);

    state.values = result.nextParams;
    state.features = result.nextFeatures;
    const snapshot = this.addSnapshot(state, result.message);
    this.acceptedCommits += 1;
    const receipt: EditorReceipt = {
      version: 1,
      projectId: state.id,
      operationId: request.operationId,
      requestDigest: digest,
      baseEditorRevision: request.baseEditorRevision,
      editorRevision: this.editorRevision(state.id),
      snapshotId: snapshot.id,
      values: { ...state.values },
      sidecarDigest: sidecarDigest({ version: 1, features: state.features })
    };
    state.claims.set(request.operationId, {
      requestDigest: digest,
      status: 200,
      body: receipt,
      response: { version: 1, state: "committed", receipt },
      accepted: result.accepted
    });
    this.afterCommit?.(state.id);
    return json(200, receipt);
  }

  private revert(state: ProjectState, snapshotId: string): Response {
    const target = state.snapshots.find((s) => s.id === snapshotId);
    if (!target) return apiError(404, "NOT_FOUND", "no snapshot");
    state.values = { ...target.params };
    const snapshot = this.addSnapshot(state, `revert to ${snapshotId}`);
    return json(200, { snapshot, scad: state.scad });
  }

  private chat(state: ProjectState): Response {
    const encoder = new TextEncoder();
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    const fast = this.fastChat;
    this.fastChat = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const started = { type: "turn_started", turn_id: turnId, project_id: state.id, max_passes: 2 };
        const frame = (event: { type: string }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        if (fast) {
          this.externalWrite(state.id, fast.values);
          const done = { type: "turn_done", turn_id: turnId, status: "completed", passes_used: 1, summary: "Done.", usage: null };
          controller.enqueue(encoder.encode(frame(started) + frame(done)));
          controller.close();
          return;
        }
        this.chatController = controller;
        controller.enqueue(encoder.encode(frame(started)));
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
}
