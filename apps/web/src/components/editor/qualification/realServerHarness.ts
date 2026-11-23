// SPDX-License-Identifier: Apache-2.0
//
// S3-C C5 — the REAL-server harness for the controller qualification suite
// (Issue #137, Stage 1).
//
// What this file is:
//  - A server-child starter. It spawns the BUILT `apps/server` (`dist/index.js`)
//    as a child process on a parent-reserved free port and waits for
//    `GET /api/health`. Nothing about the server is stubbed: the child is the
//    real product, talking to the real production store under a temp
//    `SCADFORGE_PROJECTS_DIR`.
//  - A child tracker: every child is killed AND awaited, even when the test
//    failed.
//  - A fetch interceptor. It shapes the WIRE only — it can hold a request
//    before it is sent, withhold a response, or replace a response with a
//    synthetic network error. It NEVER fabricates a server answer: every body
//    the tests read came from the real server.
//  - Store helpers: seed a sidecar, mint an engine-free `remove-feature`
//    proof, read the real editor document, count the real snapshots.
//
// What this file is NOT: test support only, never imported by a production
// file. It reaches the server by RUNTIME PATH (`dist/index.js`), never by a
// module import — `apps/web` gains no dependency on `apps/server`. (Same
// technique as `apps/web/src/components/inspect/fixtures.docker.test.ts`, which
// reaches `evals/` the same way.)
//
// The approval that governs this file: the Tech Lead's plan approval for
// Issue #137 Stage 1, conditions 4, 6 and 8.

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EditorDocument,
  EditorFeature,
  EditorIntent,
  EditorProofResponse,
  EditorSidecar,
  EditorTraversal,
  ParamValues
} from "@scadforge/protocol";
import { listSnapshots, persistProofRecord, projectFilePath, runProbe, withRecoveredProject, writeSidecarLocked } from "@scadforge/scad-core";
import { createApiClient, type ApiClient } from "../../../lib/apiClient.js";
import { createEditorClient, type DisposableEditorClient } from "../client/editorClient.js";
import { TransactionController } from "../controller/controller.js";
import { createInMemoryBroadcastChannelFactory } from "../controller/testDoubles.js";
import { createPendingReceiptStore, type PendingReceiptStore } from "../controller/pendingReceipts.js";
import type { BroadcastChannelFactory, ControllerState, TimerLike } from "../controller/types.js";
import type { EditorEligibility, EditorSidecarStatus } from "@scadforge/protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/web/src/components/editor/qualification/` -> the repository root. */
export const REPO_ROOT = join(HERE, "../../../../../..");
/** The built server entry point — reached by PATH, never imported. */
export const SERVER_DIST_ENTRY = join(REPO_ROOT, "apps", "server", "dist", "index.js");

/** The env var the server reads its project root from (server's `project-paths.ts`). */
export const PROJECTS_DIR_ENV_VAR = "SCADFORGE_PROJECTS_DIR";

// ── build precondition ──────────────────────────────────────────────────────

/**
 * Fails at once, with an actionable message, when the server has not been
 * built. The real-server tests need `apps/server/dist/index.js`; the
 * Verification Gate builds before it tests, but a developer running ONE file
 * without a build must get a clear instruction rather than a spawn error.
 */
export async function assertServerBuilt(): Promise<void> {
  try {
    await access(SERVER_DIST_ENTRY, fsConstants.F_OK);
  } catch {
    throw new Error(
      `c5-qualification: the built server is missing at '${SERVER_DIST_ENTRY}' — run \`pnpm -r build\` first ` +
        "(the real-server tests drive the built `apps/server` child)."
    );
  }
}

// ── bounded waiting (never a sleep as synchronization) ─────────────────────

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description: string;
}

/** Bounded polling on a condition — the same discipline `server-fault-harness.ts` uses. */
export async function waitFor(check: () => Promise<boolean> | boolean, options: WaitForOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`c5-qualification: condition '${options.description}' was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ── child tracking ─────────────────────────────────────────────────────────

export function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<ExitInfo> {
  if (!isRunning(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`c5-qualification: child pid=${child.pid ?? "?"} did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export async function killChild(child: ChildProcess): Promise<void> {
  if (!isRunning(child)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 5000).catch(() => {});
}

export interface ChildTracker {
  track(child: ChildProcess): ChildProcess;
  /** Kills every tracked child, awaits each, then throws if any of THOSE children is still running. */
  killAll(): Promise<void>;
}

export function createChildTracker(): ChildTracker {
  const children: ChildProcess[] = [];
  return {
    track(child) {
      children.push(child);
      return child;
    },
    async killAll() {
      const snapshot = children.splice(0);
      await Promise.all(snapshot.map((child) => killChild(child)));
      const stillRunning = snapshot.filter(isRunning);
      if (stillRunning.length > 0) {
        throw new Error(
          `c5-qualification: ${stillRunning.length} child process(es) still running after killAll ` +
            `(pid(s): ${stillRunning.map((c) => c.pid).join(", ")})`
        );
      }
    }
  };
}

// ── the server child ───────────────────────────────────────────────────────

/** Bounded capture of a child's stdout/stderr (last 64 KB each). */
export interface ChildOutput {
  stdout(): string;
  stderr(): string;
}

function captureOutput(child: ChildProcess): ChildOutput {
  const limit = 64 * 1024;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-limit);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-limit);
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr
  };
}

/**
 * Reserve a real free port in the PARENT, then release it. The server prints
 * the port it was CONFIGURED with, so `PORT=0` cannot be polled for
 * readiness; the same reserve→release→spawn dance as
 * `apps/server/src/test-support/server-fault-harness.ts` is the only way to
 * learn the port the child actually bound.
 */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        server.close();
        reject(new Error("c5-qualification: could not read a bound address while reserving a free port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export interface ServerChildHandle {
  child: ChildProcess;
  baseUrl: string;
  port: number;
  output: ChildOutput;
}

export interface StartServerChildOptions {
  /** How many reserve→spawn→ready attempts before giving up (a port race is the usual cause). */
  startAttempts?: number;
  readyTimeoutMs?: number;
}

/**
 * Spawns the real, built `apps/server` and waits for `GET /api/health`.
 *
 * Port collision: a port is reserved in the parent and released before the
 * child binds it, so the release→bind window is real. If the child exits
 * before it is ready (the collision's signature), the whole
 * reserve→spawn→ready sequence is retried on a FRESH port, up to
 * `startAttempts` times. Only the last attempt's failure is thrown — and it
 * always carries the child's captured stdout/stderr, which the existing
 * server-side harness does NOT report (the gap Issue #137's fourth comment
 * names).
 */
export async function startServerChild(
  tracker: ChildTracker,
  projectsDir: string,
  options: StartServerChildOptions = {}
): Promise<ServerChildHandle> {
  await assertServerBuilt();
  const attempts = options.startAttempts ?? 3;
  const failures: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = tracker.track(
      spawn(process.execPath, [SERVER_DIST_ENTRY], {
        env: {
          ...process.env,
          PORT: String(port),
          [PROJECTS_DIR_ENV_VAR]: projectsDir
        },
        stdio: ["ignore", "pipe", "pipe"]
      })
    );
    const output = captureOutput(child);

    const failure = await waitForReady(child, baseUrl, output, options.readyTimeoutMs ?? 20_000);
    if (failure === null) return { child, baseUrl, port, output };

    failures.push(`attempt ${attempt} (port ${port}): ${failure}`);
    await killChild(child);
  }

  throw new Error(
    `c5-qualification: the server child did not become ready after ${attempts} attempt(s):\n${failures.join("\n")}`
  );
}

async function waitForReady(
  child: ChildProcess,
  baseUrl: string,
  output: ChildOutput,
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isRunning(child)) {
      return (
        `the child exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})\n` +
        `--- child stdout ---\n${output.stdout()}\n--- child stderr ---\n${output.stderr()}`
      );
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return null;
    } catch {
      // ECONNREFUSED while the server is still starting — keep polling.
    }
    if (Date.now() >= deadline) {
      return (
        `the child stayed alive but never became healthy within ${timeoutMs}ms\n` +
        `--- child stdout ---\n${output.stdout()}\n--- child stderr ---\n${output.stderr()}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ── the wire interceptor ───────────────────────────────────────────────────

export type FetchMatcher = (url: string, method: string) => boolean;

export interface FetchCall {
  method: string;
  url: string;
  /** The request body, verbatim — what lets a case prove a re-send was byte-identical. */
  body: string | null;
  status: number | null;
  /** The rejection's message, when the request never produced a response. */
  error: string | null;
  /** The parsed `{error_code, message}` body, when the response carried one. */
  errorBody: { error_code: string; message: string } | null;
}

export interface FetchHold {
  /** Resolves once the held request has actually been forwarded to the transport. */
  readonly forwarded: Promise<void>;
  release(): void;
}

export interface InterceptedFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: readonly FetchCall[];
  /** The next matching request is held BEFORE it is sent; `release()` lets it through. */
  holdNext(match: FetchMatcher): FetchHold;
  /** The next matching request is performed, but its response is replaced by a thrown network error. */
  dropNextResponse(match: FetchMatcher): void;
  /** The next matching request's response is withheld until `gate` resolves. */
  delayNextResponse(match: FetchMatcher, gate: Promise<void>): void;
  /** The next matching request runs `before` (awaited) before it is forwarded. */
  beforeNext(match: FetchMatcher, before: () => Promise<void>): void;
  callsMatching(match: FetchMatcher): FetchCall[];
}

interface FetchRule {
  match: FetchMatcher;
  kind: "hold" | "drop" | "delay" | "before";
  released?: Promise<void>;
  markForwarded?: () => void;
  gate?: Promise<void>;
  before?: () => Promise<void>;
}

/**
 * A `fetch` that records every call and can shape the wire — but never
 * invents a server answer. The three shapes it can impose are:
 *  - `holdNext`: the request is not put on the wire until released (the
 *    server has not seen it at all);
 *  - `dropNextResponse`: the request IS performed and the server's real
 *    answer arrives, but the caller sees a network error instead (the
 *    "the response was lost" case);
 *  - `delayNextResponse`: the request is performed and the real response is
 *    withheld until the gate resolves.
 */
export function createInterceptedFetch(): InterceptedFetch {
  const calls: FetchCall[] = [];
  const rules: FetchRule[] = [];

  function takeRule(url: string, method: string): FetchRule | undefined {
    const index = rules.findIndex((rule) => rule.match(url, method));
    if (index === -1) return undefined;
    return rules.splice(index, 1)[0];
  }

  function recordBody(call: FetchCall, res: Response): void {
    if (res.ok) return;
    void res
      .clone()
      .text()
      .then((text) => {
        if (text.length === 0) return;
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed !== null && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            call.errorBody = {
              error_code: typeof record.error_code === "string" ? record.error_code : "UNKNOWN",
              message: typeof record.message === "string" ? record.message : ""
            };
          }
        } catch {
          // A non-JSON error body is not an ApiError; the record keeps a null errorBody.
        }
      })
      .catch(() => {
        // Reading the body for the record must never affect the caller.
      });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    const call: FetchCall = { method, url, body, status: null, error: null, errorBody: null };
    calls.push(call);
    const rule = takeRule(url, method);

    try {
      if (rule?.kind === "before" && rule.before) await rule.before();
      if (rule?.kind === "hold") {
        await rule.released;
        rule.markForwarded?.();
      }
      const res = await fetch(input as RequestInfo, init);
      call.status = res.status;
      recordBody(call, res);
      if (rule?.kind === "delay" && rule.gate) await rule.gate;
      if (rule?.kind === "drop") {
        throw new Error("c5-qualification: the response was lost after the request was sent");
      }
      return res;
    } catch (cause) {
      call.error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    }
  };

  return {
    fetchImpl,
    calls,
    holdNext(match) {
      let release!: () => void;
      let markForwarded!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const forwarded = new Promise<void>((resolve) => {
        markForwarded = resolve;
      });
      rules.push({ match, kind: "hold", released, markForwarded });
      return { forwarded, release };
    },
    dropNextResponse(match) {
      rules.push({ match, kind: "drop" });
    },
    delayNextResponse(match, gate) {
      rules.push({ match, kind: "delay", gate });
    },
    beforeNext(match, before) {
      rules.push({ match, kind: "before", before });
    },
    callsMatching(match) {
      return calls.filter((call) => match(call.url, call.method));
    }
  };
}

// ── projects, documents, proofs, snapshots ─────────────────────────────────

export interface TempProjectsDir {
  dir: string;
  cleanup(): Promise<void>;
}

/** A temp project root for one test file; the server child is pointed at it. */
export async function createProjectsDir(prefix = "scadforge-c5-"): Promise<TempProjectsDir> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

/** The project's directory inside a projects root (the server's own layout: one flat dir per project id). */
export function projectDirOf(projectsDir: string, projectId: string): string {
  return join(projectsDir, projectId);
}

export interface CreatedProject {
  projectId: string;
  dir: string;
  scad: string;
}

/** Creates a real project through the real route (`POST /api/projects`). */
export async function createProject(
  baseUrl: string,
  projectsDir: string,
  options: { name: string; scad: string }
): Promise<CreatedProject> {
  const res = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: options.name, scad: options.scad })
  });
  if (res.status !== 201) {
    throw new Error(`c5-qualification: POST /api/projects answered ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { project: { id: string } };
  return {
    projectId: body.project.id,
    dir: projectDirOf(projectsDir, body.project.id),
    scad: options.scad
  };
}

/**
 * Seeds the project's sidecar directly in the production store — the same
 * technique `apps/server/src/services/fault-editor-matrix.test.ts` uses. No
 * route can create a feature except an editor command itself, so seeding is
 * what isolates a case from the editor machinery it is not testing.
 */
export async function seedSidecar(dir: string, features: readonly EditorFeature[]): Promise<void> {
  const sidecar: EditorSidecar = { version: 1, features: [...features] };
  await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, sidecar));
}

/** The real editor document, read through the real route. */
export async function readEditorDocument(api: ApiClient, projectId: string): Promise<EditorDocument> {
  return api.getEditorDocument(projectId);
}

/** The real snapshot count, read straight from the production store. */
export async function snapshotCountOf(dir: string): Promise<number> {
  return (await listSnapshots(dir)).length;
}

/**
 * The project's head snapshot id, read straight off disk — WITHOUT taking the
 * project lock, so a case can inspect the store while it deliberately holds
 * that lock (the lock-contention cases do exactly that).
 */
export async function readProjectHeadLockFree(dir: string): Promise<string | null> {
  const raw = await readFile(projectFilePath(dir), "utf8");
  const manifest = JSON.parse(raw) as { head?: string | null };
  return manifest.head ?? null;
}

/** `remove-feature`'s probe never renders (it returns before planning samples), so its proof is engine-free. */
const EMPTY_SCHEMA = { title: "", parameters: [] } as never;

export interface RemoveFeatureProofOptions {
  dir: string;
  projectId: string;
  baseEditorRevision: string;
  scad: string;
  params: ParamValues;
  features: readonly EditorFeature[];
  featureId: string;
  bindingVersion: number;
  /** Defaults to `"edit"`. A traversal's proof must carry the traversal it covers. */
  intent?: EditorIntent;
  /** Defaults to `null`. */
  traversal?: EditorTraversal | null;
}

/**
 * Mints a genuine, durably-persisted proof for a `remove-feature` command,
 * in-process, and returns it in the wire shape the controller consumes.
 *
 * This is the `fault-editor-matrix.test.ts` precedent: `remove-feature`'s own
 * probe is engine-free (`runProbe` returns before it plans or renders any
 * sample), so the proof is real — it is the same record the server's own
 * route would persist — without the OpenSCAD container. Files that use it
 * therefore do NOT exercise the HTTP verify route.
 */
export async function mintRemoveFeatureProof(options: RemoveFeatureProofOptions): Promise<EditorProofResponse> {
  const result = await runProbe({
    projectId: options.projectId,
    baseEditorRevision: options.baseEditorRevision,
    scad: options.scad,
    authoritativeParams: options.params,
    schema: EMPTY_SCHEMA,
    features: [...options.features],
    command: { kind: "remove-feature", featureId: options.featureId, bindingVersion: options.bindingVersion },
    intent: options.intent ?? "edit",
    traversal: options.traversal ?? null
  });
  if (result.status !== "proved") {
    throw new Error(`c5-qualification: the remove-feature proof was unexpectedly refused: ${result.reason}`);
  }
  await persistProofRecord(options.dir, result.record);
  return {
    version: 1,
    proofId: result.record.proofId,
    commandDigest: result.record.commandDigest,
    baseEditorRevision: result.record.baseEditorRevision,
    expiresAt: result.record.expiresAt
  };
}

// ── the host ───────────────────────────────────────────────────────────────

/**
 * The test PLAYS THE HOST (Tech-Lead condition 4): where `App`/`useEditorSession`
 * would re-read the document, set guard inputs or drive the preview port, this
 * harness does the same thing, from a real server read.
 */
export interface QualificationHost {
  /** The project this host acts for. */
  readonly projectId: string;
  api: ApiClient;
  client: DisposableEditorClient;
  controller: TransactionController;
  /** Project ids the client reported as a definite CONFLICT. */
  readonly conflicts: string[];
  /** How many peer-committed signals the controller received. */
  peerCommitted: number;
  pendingReceipts: PendingReceiptStore;
}

export interface HostOptions {
  baseUrl: string;
  projectId: string;
  fetchImpl: typeof fetch;
  /** The client's per-attempt timeout. Shortened only where a case needs a fast ambiguity. */
  timeoutMs?: number;
  /**
   * The controller's second-tab channel. Two hosts that must see each other's
   * peer-committed signal share ONE factory (C2's own in-memory bus from
   * `controller/testDoubles.ts`); the default gives every host its own bus.
   */
  broadcastChannelFactory?: BroadcastChannelFactory;
}

const REAL_TIMER: TimerLike = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle)
};

export function createHost(options: HostOptions): QualificationHost {
  const api = createApiClient({ baseUrl: options.baseUrl, fetchImpl: options.fetchImpl });
  const conflicts: string[] = [];
  const client = createEditorClient({
    client: api,
    onDefiniteConflict: (projectId) => conflicts.push(projectId),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  });
  const pendingReceipts = createPendingReceiptStore();
  const host: QualificationHost = {
    projectId: options.projectId,
    api,
    client,
    controller: new TransactionController({
      projectId: options.projectId,
      client,
      clock: () => Date.now(),
      timer: REAL_TIMER,
      uuid: () => randomUUID(),
      broadcastChannelFactory: options.broadcastChannelFactory ?? createInMemoryBroadcastChannelFactory(),
      onPeerCommitted: () => {
        host.peerCommitted += 1;
      },
      pendingReceipts
    }),
    conflicts,
    peerCommitted: 0,
    pendingReceipts
  };
  return host;
}

/** Disposes the controller and the client (the controller first: it holds the client's records). */
export function disposeHost(host: QualificationHost): void {
  host.controller.dispose();
  host.client.dispose();
}

/**
 * The real verify route (`POST /api/projects/:id/editor/verify`) — the only
 * way the `@docker` files obtain a proof. It compiles the source through the
 * pinned OpenSCAD image, so it needs the container.
 */
export async function verifySetValue(
  api: ApiClient,
  projectId: string,
  options: {
    baseEditorRevision: string;
    featureId: string;
    bindingVersion: number;
    value: number;
  }
): Promise<EditorProofResponse> {
  return api.verifyEditorCommand(projectId, {
    version: 1,
    baseEditorRevision: options.baseEditorRevision,
    command: {
      kind: "set-value",
      featureId: options.featureId,
      bindingVersion: options.bindingVersion,
      value: options.value
    },
    intent: "edit",
    traversal: null
  });
}

/** Writes the preview sample the preview adapter would write, at the port's current generation. */
export function writePreviewSample(controller: TransactionController, value: number): void {
  const state: ControllerState = controller.state();
  if (state.kind !== "preview-pending" && state.kind !== "preview-ok") {
    throw new Error(`c5-qualification: writePreviewSample needs a previewing gesture, but the state is "${state.kind}"`);
  }
  controller.portWriter.write({ value, generation: state.portGeneration });
}

/** The eligibility entry for one feature, as the real document reports it. */
export function eligibilityOf(document: EditorDocument, featureId: string): EditorEligibility | null {
  return document.eligibility.find((entry) => entry.featureId === featureId) ?? null;
}

/** The sidecar status the real document reports. */
export function sidecarStatusOf(document: EditorDocument): EditorSidecarStatus {
  return document.sidecarStatus;
}

// ── the clamp fixture (the `@docker` files) ────────────────────────────────

/**
 * The repository's clamp fixture — the ONE geometry whose linear binding is
 * already PROVEN by `packages/scad-core/src/editor/proof.docker.test.ts`
 * ("clamp: linear wall binding (scale-2, centered)"). The `@docker` files
 * reuse that exact binding, so their proofs are the real thing rather than a
 * guess.
 */
export const CLAMP_SCAD_PATH = join(REPO_ROOT, "evals", "scenario-a2", "fixture", "clamp.scad");
export const CLAMP_PARAMS = { pipe_dia: 32, wall: 3, width: 20, plate: 4, screw_dia: 4.5 };
export const CLAMP_WALL_FEATURE_ID = "11111111-1111-4111-8111-111111111111";

export interface ClampFeatureOverrides {
  createdAtRevision?: string;
  sourceFingerprint?: string;
  bindingVersion?: number;
}

/** The clamp's proven wall binding (scale 2, centered, offset pipe_dia+plate-1). */
export function clampWallFeature(projectId: string, overrides: ClampFeatureOverrides = {}): EditorFeature {
  return {
    featureId: CLAMP_WALL_FEATURE_ID,
    label: "Clamp wall",
    projectId,
    createdAtRevision: overrides.createdAtRevision ?? "a".repeat(64),
    sourceFingerprint: overrides.sourceFingerprint ?? "b".repeat(64),
    bindingVersion: overrides.bindingVersion ?? 1,
    provenance: { kind: "manual" },
    binding: {
      kind: "linear",
      parameter: "wall",
      axis: "x",
      mapping: { scale: 2, offset: CLAMP_PARAMS.pipe_dia + CLAMP_PARAMS.plate - 1, anchor: "center" }
    }
  };
}

/**
 * Creates the clamp project through the REAL routes: `POST /api/projects`
 * with the fixture's source, then `PUT /api/projects/:id/params` with the
 * fixture's own Customizer defaults (the create route stores EMPTY params,
 * and the proven binding is calibrated against those defaults). The params
 * write carries `snapshot: false`, so it adds no snapshot of its own.
 */
export async function createClampProject(
  baseUrl: string,
  projectsDir: string,
  name: string
): Promise<CreatedProject> {
  const scad = await readFile(CLAMP_SCAD_PATH, "utf8");
  const project = await createProject(baseUrl, projectsDir, { name, scad });
  const api = createApiClient({ baseUrl });
  await api.updateParams(project.projectId, { values: CLAMP_PARAMS, snapshot: false });
  return project;
}
