// SPDX-License-Identifier: Apache-2.0
//
// Fault qualification (Issue #110, S3-B ticket B8, Phase 2) -- the editor
// `remove-feature` crash matrix, restart-receipt survival, the two-process
// editor race, and the abort-marking-failure injection. All against a REAL
// `apps/server` child, driven over HTTP, via the shared helpers in
// `../test-support/server-fault-harness.ts` (Issue #99's server-child mode,
// extracted for reuse -- C6 on Issue #110).
//
// ── WHY NO `POST .../editor/verify` CALL ANYWHERE IN THIS FILE ────────────
//
// `scad-core-impl.ts`'s `verifyEditorCommand` unconditionally calls
// `compileProposedSource` (a real OpenSCAD/Docker subprocess) to derive the
// Customizer schema, for EVERY command kind -- including `remove-feature`,
// whose own proof step (`editor/proof.ts`'s `runProbe`) is otherwise
// engine-free (it returns early, `samples: []`, never touching `schema` at
// all). So the HTTP verify ROUTE always needs Docker, even though the
// underlying proof primitive does not. Since this file's whole point is the
// crash/recovery machinery (`createSnapshotLocked`'s staging/publish, the
// claim lifecycle), not the schema-derivation wrapper, every case here calls
// scad-core's own exported `runProbe` + `persistProofRecord` DIRECTLY
// in-process (the exact functions the real route itself calls, minus the
// engine-dependent schema compile remove-feature never reads) to mint a
// genuine, durably-persisted proof record and `proofId` -- then drives the
// REAL `POST .../editor/commands` route with it. `baseEditorRevision` is
// likewise computed via scad-core's own exported pure functions
// (`computeSourceRevision`/`editorRevision`/`sidecarDigest`/
// `canonicalSidecar`) rather than a `GET .../editor` call, for the same
// reason. The one `@docker` case that DOES need the engine end-to-end lives
// in `fault-editor-setvalue.docker.test.ts`.
//
// ── FINDING F3 (Issue #111, confirmed by the Tech Lead) ────────────────────
//
// `after-claim` is unreachable on the real path: `transaction.ts`'s
// `commitWithClaimLocked` (the only call site of `faultPoint("after-claim")`)
// is never invoked -- `submitEditorCommand` calls `reserveClaimLocked`
// directly. The crash window it models (a claim durable, no staging
// transaction started yet) is real risk, so its cell below is NOT skipped
// outright: it is parametrized to self-detect today's dead-code state (the
// request completes normally, no kill) and `ctx.skip()` with a reason
// naming #111, so the SAME case starts asserting for real the moment the
// fixup lands and B6 wires the route through the fault-armed path.
//
// ── WHY THE CLASSIFIER IS ITS OWN FUNCTION, WITH ITS OWN PROOF TEST ────────
//
// An earlier version of this file raced `postCommand(...).catch(() => null)`
// against the child's `exit` event, so a REJECTED fetch (a connection reset
// -- the common real-world signature of a genuine kill: the socket reset
// usually reaches this client BEFORE the parent observes the child's own
// `exit` event) collapsed into the SAME resolved value a successful HTTP 200
// produces, making a real kill indistinguishable from "the route just
// completed normally" and able to SKIP a case that should have failed --
// exactly the silent-never-runs failure a fixup-pending cell must not have.
// `raceEditorCommandAgainstExit` below keeps resolve and reject strictly
// distinct and only ever reaches `dead-code` on a resolved HTTP 200 carrying
// THIS operation's own committed receipt while the child is still alive;
// anything else resolved is `unexpected-response` (fails loudly, never
// skips); a rejection is always `killed` (a bounded, throwing wait for the
// exit event -- never a silent skip). Its own dedicated test below proves
// this against a GUARANTEED, reachable kill (`after-full-staging`, the same
// `postCommand`/server-child code path) so a regression here cannot silently
// start skipping the moment #111 lands.
//
// ── FINDING F4 (discovered building this file, empirically verified) ──────
//
// The abort-marking-failure injection (AC4) does NOT leave `lookupClaimLocked`
// answering "not yet definitely_not_committed" while the injected failure is
// in effect, as the issue's wording might suggest. `claims.ts`'s
// `recordClaimAbortedLocked` IS swallowed inside `abortTransactionLocked`'s
// own row-1 path (`.catch(() => {})`), but `store/transaction.ts`'s
// `recoverPendingClaimsLocked` calls the SAME function through
// `withTypedError` with NO catch -- so once the pending-marker sweep (which
// runs on EVERY boundary entry, right after the transaction-abort sweep)
// retries the SAME still-pending marker and hits the SAME blocked write, the
// failure PROPAGATES and the ENTIRE `withRecoveredProject` call for that
// project REJECTS with `INTERNAL_ERROR` -- not just this one claim reading
// as non-terminal, but the whole project unreadable/unwritable until the
// injected failure clears. Verified empirically (a throwaway repro script,
// not committed) before writing this file's assertions below. The EVENTUAL
// outcome the AC cares about still holds exactly as specified (self-heals to
// `definitely_not_committed`/`aborted` the moment the failure clears, never
// a permanent pending state) -- only the INTERMEDIATE observation differs:
// this file asserts the boundary call itself rejects while blocked (real
// positive evidence the injection fired) and reads the marker/claim-file/
// root bytes directly off disk for the "not yet resolved" assertions,
// instead of going through the (necessarily-failing) recovery boundary.
// Reported to the Tech Lead as its own finding, since it means a single
// transient claim-marking failure is far more disruptive than "one claim
// stuck pending" -- it is "this whole project is unreadable for a while".

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PARAMS_ACTIVE_PRESET,
  canonicalSidecar,
  computeSourceRevision,
  editorRevision as computeEditorRevision,
  listSnapshots,
  lookupClaimLocked,
  persistProofRecord,
  projectFilePath,
  readProjectManifest,
  rootModelPath,
  rootParamsPath,
  runProbe,
  sidecarDigest as computeSidecarDigest,
  withRecoveredProject,
  writeSidecarLocked
} from "@scadforge/scad-core";
import type { FaultPointName, ParamValues } from "@scadforge/scad-core";
import type {
  CreateProjectRequest,
  EditorCommand,
  EditorCommitRequest,
  EditorFeature,
  EditorOperationResponse,
  EditorReceipt,
  EditorSidecar,
  ProjectResponse
} from "@scadforge/protocol";
import { projectDir } from "./project-paths.js";
import {
  assertFaultPointEnvClean,
  assertServerBuilt,
  createChildTracker,
  isRunning,
  killChild,
  startServerChild,
  waitForExit
} from "../test-support/server-fault-harness.js";

// ═════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════

const MODEL_SCAD = "size = 10;\ncube(size);\n";
/** `runProbe`'s `remove-feature` branch never reads `schema` at all (see module header) -- an empty stand-in is exact, not a shortcut. */
const EMPTY_SCHEMA = { title: "", parameters: [] };

const FEATURE_A = "11111111-1111-4111-8111-111111111111";
const FEATURE_B = "22222222-2222-4222-8222-222222222222";

function feature(id: string): EditorFeature {
  return {
    featureId: id,
    label: `Feature ${id.slice(0, 8)}`,
    projectId: "fault-editor-matrix",
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "size", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } }
  };
}

function removeCommand(featureId: string): EditorCommand {
  return { kind: "remove-feature", featureId, bindingVersion: 1 };
}

// ═════════════════════════════════════════════════════════════════════════
// after-claim's crash/dead-code classifier -- see the F3 module-header note
// above for why a rejected fetch must never be collapsed into "responded".
// ═════════════════════════════════════════════════════════════════════════

type EditorCommandRaceOutcome =
  | { kind: "dead-code"; status: number; body: unknown }
  | { kind: "killed"; signal: NodeJS.Signals | null }
  | { kind: "unexpected-response"; status: number; body: unknown };

function looksLikeCommittedReceiptFor(body: unknown, operationId: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return candidate.operationId === operationId && typeof candidate.snapshotId === "string" && typeof candidate.editorRevision === "string";
}

/**
 * Classifies a `POST .../editor/commands` request against its own armed
 * server child. `dead-code` is reached ONLY on a resolved HTTP 200 whose
 * body is exactly this operation's own committed receipt AND the child is
 * still alive at the moment that is checked -- a resolved response of ANY
 * OTHER shape (a different status, or a 200 without a matching receipt) is
 * `unexpected-response`, which the caller must FAIL on, never skip. A
 * REJECTED fetch (a connection reset) is always `killed`: `waitForExit`
 * throws (a real test failure, never a silent skip) if the child does not
 * actually exit within its bound.
 */
async function raceEditorCommandAgainstExit(
  child: ChildProcess,
  responsePromise: Promise<Response>,
  operationId: string
): Promise<EditorCommandRaceOutcome> {
  type Settlement = { kind: "resolved"; status: number; body: unknown } | { kind: "rejected" };
  const settlementPromise: Promise<Settlement> = responsePromise.then(
    async (res) => ({ kind: "resolved" as const, status: res.status, body: await res.json().catch(() => null) }),
    () => ({ kind: "rejected" as const })
  );

  const exitPromise = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
    if (!isRunning(child)) {
      resolve({ signal: child.signalCode });
      return;
    }
    child.once("exit", (_code, signal) => resolve({ signal }));
  });

  const raced = await Promise.race([
    settlementPromise.then((settlement) => ({ from: "settlement" as const, settlement })),
    exitPromise.then((exit) => ({ from: "exit" as const, exit }))
  ]);

  if (raced.from === "exit") {
    return { kind: "killed", signal: raced.exit.signal };
  }

  if (raced.settlement.kind === "rejected") {
    // The common real-world ordering for a genuine kill: the socket reset
    // reaches this client before the parent observes the child's own
    // 'exit' event. Bounded wait (throws on timeout -- a test FAILURE,
    // never a skip); this is what proves a real kill is never masked.
    const exitInfo = await waitForExit(child, 10000);
    return { kind: "killed", signal: exitInfo.signal };
  }

  const { status, body } = raced.settlement;
  if (status === 200 && looksLikeCommittedReceiptFor(body, operationId) && isRunning(child)) {
    return { kind: "dead-code", status, body };
  }
  return { kind: "unexpected-response", status, body };
}

// `FaultPointName`'s own declaration order in `transaction.ts` is its
// chronological firing order (see Phase 1's `fault-matrix.test.ts`).
const FAULT_POINT_ORDER: readonly FaultPointName[] = [
  "after-claim",
  "after-partial-staging",
  "after-full-staging",
  "after-commit",
  "after-publish-history",
  "after-publish-root-source",
  "after-publish-root-params",
  "after-publish-root-sidecar",
  "after-publish-project",
  "after-publish-record"
];

function isCommittedAt(fp: FaultPointName): boolean {
  return FAULT_POINT_ORDER.indexOf(fp) >= FAULT_POINT_ORDER.indexOf("after-commit");
}

/** Every point a `remove-feature` editor commit's OWN `createSnapshotLocked` call reaches -- confirmed by reading `submitEditorCommand`: it always stages `sidecar`+`model`+`params`+`project`, and sets `editor.claim`+`receipt`, so `after-publish-record` fires too (new for Phase 2). Everything except `after-claim` (F3). */
const REMOVE_FEATURE_POINTS: readonly FaultPointName[] = [
  "after-partial-staging",
  "after-full-staging",
  "after-commit",
  "after-publish-history",
  "after-publish-root-source",
  "after-publish-root-params",
  "after-publish-root-sidecar",
  "after-publish-project",
  "after-publish-record"
];

// ═════════════════════════════════════════════════════════════════════════
// Seeding + pure revision computation (no engine, no HTTP GET needed)
// ═════════════════════════════════════════════════════════════════════════

interface SeededProject {
  projectId: string;
  dir: string;
  scad: string;
  params: ParamValues;
  sidecar: EditorSidecar;
  baseEditorRevision: string;
}

async function seedProject(tracker: ReturnType<typeof createChildTracker>, projectsDir: string, features: EditorFeature[]): Promise<SeededProject> {
  const setup = await startServerChild(tracker, projectsDir);
  const body: CreateProjectRequest = { name: `fault-editor-${randomUUID().slice(0, 8)}`, scad: MODEL_SCAD };
  const res = await fetch(`${setup.baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as ProjectResponse;
  const projectId = created.project.id;
  await killChild(setup.child);

  const dir = projectDir(projectsDir, projectId);
  const sidecar: EditorSidecar = { version: 1, features };
  // No route can create a feature except an editor command itself
  // (established precedent: `editor-commit.docker.test.ts`) -- seeding
  // directly is what isolates this file to the crash/recovery machinery.
  await withRecoveredProject(dir, (ctx) => writeSidecarLocked(ctx, sidecar));

  const manifest = await readProjectManifest(dir);
  const scad = await readFile(rootModelPath(dir), "utf8");
  const paramsRaw = JSON.parse(await readFile(rootParamsPath(dir), "utf8")) as { parameterSets?: Record<string, ParamValues> };
  const params = (paramsRaw.parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) as ParamValues;
  const sourceRevision = computeSourceRevision(manifest.head, scad, params);
  const digest = computeSidecarDigest(canonicalSidecar(sidecar));
  const baseEditorRevision = computeEditorRevision(sourceRevision, digest);

  return { projectId, dir, scad, params, sidecar, baseEditorRevision };
}

/** Mints a genuine, durably-persisted proof record for a `remove-feature` command -- see the module header for why this bypasses the HTTP verify route entirely. */
async function issueRemoveFeatureProof(seeded: SeededProject, featureId: string): Promise<string> {
  const result = await runProbe({
    projectId: seeded.projectId,
    baseEditorRevision: seeded.baseEditorRevision,
    scad: seeded.scad,
    authoritativeParams: seeded.params,
    schema: EMPTY_SCHEMA,
    features: seeded.sidecar.features,
    command: removeCommand(featureId),
    intent: "edit",
    traversal: null
  });
  if (result.status !== "proved") {
    throw new Error(`fault-editor-matrix: proof unexpectedly refused: ${result.reason}`);
  }
  await persistProofRecord(seeded.dir, result.record);
  return result.record.proofId;
}

function commitRequestFor(seeded: SeededProject, featureId: string, operationId: string, proofId: string): EditorCommitRequest {
  return {
    version: 1,
    baseEditorRevision: seeded.baseEditorRevision,
    command: removeCommand(featureId),
    intent: "edit",
    traversal: null,
    operationId,
    proofId
  };
}

async function postCommand(baseUrl: string, projectId: string, body: EditorCommitRequest): Promise<Response> {
  return fetch(`${baseUrl}/api/projects/${projectId}/editor/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function getOperation(baseUrl: string, projectId: string, operationId: string): Promise<{ status: number; body: EditorOperationResponse }> {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/editor/operations/${operationId}`);
  return { status: res.status, body: (await res.json()) as EditorOperationResponse };
}

// ═════════════════════════════════════════════════════════════════════════
// Root-state / claim-file reading (direct fs -- byte-identical comparison,
// never through a parse/reserialize round trip; see Phase 1's
// `assertRootCoherentWithHead` for the same rationale)
// ═════════════════════════════════════════════════════════════════════════

interface RootBytes {
  model: string;
  params: string;
  project: string;
  editorSidecar: string;
}

async function readRootBytes(dir: string): Promise<RootBytes> {
  return {
    model: await readFile(rootModelPath(dir), "utf8"),
    params: await readFile(rootParamsPath(dir), "utf8"),
    project: await readFile(projectFilePath(dir), "utf8"),
    // `.scadforge/editor.json` has no exported path helper; this relative
    // layout is frozen since S3-B ticket B3 (the story's own on-disk table).
    editorSidecar: await readFile(join(dir, ".scadforge", "editor.json"), "utf8")
  };
}

function operationsDirOf(dir: string): string {
  return join(dir, ".scadforge", "editor-operations");
}

function pendingMarkerPathOf(dir: string, operationId: string): string {
  return join(operationsDirOf(dir), "pending", `${operationId}.json`);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

// ═════════════════════════════════════════════════════════════════════════
// Fixture plumbing
// ═════════════════════════════════════════════════════════════════════════

const tempDirs: string[] = [];
const tracker = createChildTracker();

async function freshProjectsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scadserver-fault-editor-"));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  await assertServerBuilt();
});

beforeEach(() => {
  assertFaultPointEnvClean();
});

afterEach(async () => {
  await tracker.killAll(); // C5: a real hygiene proof (server-fault-harness.ts)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Editor `remove-feature` crash matrix (Issue #110 AC1)
// ═════════════════════════════════════════════════════════════════════════

describe("editor remove-feature crash matrix", () => {
  for (const faultPoint of REMOVE_FEATURE_POINTS) {
    const committed = isCommittedAt(faultPoint);
    it(`${faultPoint} -> ${committed ? "committed, rolls forward" : "aborted, old state intact"}`, async () => {
      const projectsDir = await freshProjectsDir();
      const seeded = await seedProject(tracker, projectsDir, [feature(FEATURE_A), feature(FEATURE_B)]);
      const before = await readRootBytes(seeded.dir);
      const beforeCount = (await listSnapshots(seeded.dir)).length;

      const operationId = randomUUID();
      const proofId = await issueRemoveFeatureProof(seeded, FEATURE_A);
      const body = commitRequestFor(seeded, FEATURE_A, operationId, proofId);

      const crashing = await startServerChild(tracker, projectsDir, { faultPoint });
      await expect(postCommand(crashing.baseUrl, seeded.projectId, body)).rejects.toThrow();
      await waitForExit(crashing.child, 10000);
      expect(crashing.child.signalCode).toBe("SIGKILL"); // positive evidence the fault fired

      const restarted = await startServerChild(tracker, projectsDir);
      const { status: opStatus, body: opBody } = await getOperation(restarted.baseUrl, seeded.projectId, operationId);
      const after = await readRootBytes(seeded.dir);
      const afterCount = (await listSnapshots(seeded.dir)).length;
      const markerExists = await pathExists(pendingMarkerPathOf(seeded.dir, operationId));
      await killChild(restarted.child);

      expect(opStatus).toBe(200);
      expect(markerExists).toBe(false); // C4: pending marker always resolved, either way

      if (committed) {
        expect(opBody.state).toBe("committed");
        if (opBody.state === "committed") {
          expect(opBody.receipt.operationId).toBe(operationId);
          expect(opBody.receipt.values).toEqual(seeded.params);
        }
        // remove-feature never touches model/params; only project.json
        // (head advances) and editor.json (the feature is gone) change.
        expect(after.model).toBe(before.model);
        expect(after.params).toBe(before.params);
        expect(after.project).not.toBe(before.project);
        expect(JSON.parse(after.editorSidecar).features.some((f: EditorFeature) => f.featureId === FEATURE_A)).toBe(false);
        expect(afterCount).toBe(beforeCount + 1);
      } else {
        expect(opBody.state).toBe("definitely_not_committed");
        if (opBody.state === "definitely_not_committed") {
          expect(opBody.reason).toBe("aborted");
        }
        // Never a mixed root: EVERY root file is byte-identical to before the kill.
        expect(after).toEqual(before);
        expect(afterCount).toBe(beforeCount);
      }
    }, 15000);
  }

  // ── after-claim (F3, Issue #111): parametrized pending-fixup cell ────────
  it("after-claim -> PENDING FIXUP (Issue #111, F3): self-detects today's dead code, runs for real once the fixup lands", async (ctx) => {
    const projectsDir = await freshProjectsDir();
    const seeded = await seedProject(tracker, projectsDir, [feature(FEATURE_A)]);
    const before = await readRootBytes(seeded.dir);

    const operationId = randomUUID();
    const proofId = await issueRemoveFeatureProof(seeded, FEATURE_A);
    const body = commitRequestFor(seeded, FEATURE_A, operationId, proofId);

    const armed = await startServerChild(tracker, projectsDir, { faultPoint: "after-claim" });
    const outcome = await raceEditorCommandAgainstExit(armed.child, postCommand(armed.baseUrl, seeded.projectId, body), operationId);

    if (outcome.kind === "unexpected-response") {
      throw new Error(
        `fault-editor-matrix: after-claim commit returned an unexpected response ` +
          `(status=${outcome.status}): ${JSON.stringify(outcome.body)}`
      );
    }

    if (outcome.kind === "dead-code") {
      // vitest 2.x's `TestContext.skip()` takes no reason argument -- logged
      // here instead, so it is still visible in the run's own output.
      console.warn(
        "[after-claim PENDING FIXUP] after-claim is unreachable on the real editor-command path today " +
          "(F3, fixup Issue #111): submitEditorCommand never calls commitWithClaimLocked, so the fault " +
          "point never fires. Re-enable once #111 lands -- this same case will then observe the real SIGKILL."
      );
      await killChild(armed.child); // the request completed normally -- the child is still alive, clean it up
      ctx.skip();
      return;
    }

    // outcome.kind === "killed"
    expect(outcome.signal).toBe("SIGKILL");
    const restarted = await startServerChild(tracker, projectsDir);
    const { body: opBody } = await getOperation(restarted.baseUrl, seeded.projectId, operationId);
    const after = await readRootBytes(seeded.dir);
    await killChild(restarted.child);

    expect(opBody.state).toBe("definitely_not_committed");
    if (opBody.state === "definitely_not_committed") expect(opBody.reason).toBe("aborted");
    expect(after).toEqual(before); // old state intact
    // "no staging dir": after-claim fires before any staging call, so recovery has nothing to reconcile.
    const transactionsDir = join(seeded.dir, ".scadforge", "editor-transactions");
    const stillStaged = await pathExists(transactionsDir);
    expect(stillStaged).toBe(false);
  }, 15000);
});

describe("raceEditorCommandAgainstExit classifier", () => {
  it("never classifies a guaranteed real kill as dead-code (proof against a reachable fault point, after-full-staging, same postCommand/server-child code path)", async () => {
    const projectsDir = await freshProjectsDir();
    const seeded = await seedProject(tracker, projectsDir, [feature(FEATURE_A)]);
    const operationId = randomUUID();
    const proofId = await issueRemoveFeatureProof(seeded, FEATURE_A);
    const body = commitRequestFor(seeded, FEATURE_A, operationId, proofId);

    const armed = await startServerChild(tracker, projectsDir, { faultPoint: "after-full-staging" });
    const outcome = await raceEditorCommandAgainstExit(armed.child, postCommand(armed.baseUrl, seeded.projectId, body), operationId);

    expect(outcome.kind).toBe("killed");
    if (outcome.kind === "killed") expect(outcome.signal).toBe("SIGKILL");
  }, 15000);
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Restart receipt survival (Issue #110 AC2)
// ═════════════════════════════════════════════════════════════════════════

describe("restart receipt survival", () => {
  it("GET .../editor/operations/:id is committed after restart; re-sending the identical request returns the same receipt and creates no new snapshot", async () => {
    const projectsDir = await freshProjectsDir();
    const seeded = await seedProject(tracker, projectsDir, [feature(FEATURE_A)]);
    const beforeCount = (await listSnapshots(seeded.dir)).length;

    const operationId = randomUUID();
    const proofId = await issueRemoveFeatureProof(seeded, FEATURE_A);
    const body = commitRequestFor(seeded, FEATURE_A, operationId, proofId);

    const crashing = await startServerChild(tracker, projectsDir, { faultPoint: "after-commit" });
    await expect(postCommand(crashing.baseUrl, seeded.projectId, body)).rejects.toThrow();
    await waitForExit(crashing.child, 10000);
    expect(crashing.child.signalCode).toBe("SIGKILL");

    const restarted = await startServerChild(tracker, projectsDir);
    const { body: opBody } = await getOperation(restarted.baseUrl, seeded.projectId, operationId);
    expect(opBody.state).toBe("committed");
    if (opBody.state !== "committed") throw new Error("unreachable");
    const receiptFromLookup: EditorReceipt = opBody.receipt;

    const resendRes = await postCommand(restarted.baseUrl, seeded.projectId, body);
    expect(resendRes.status).toBe(200);
    const receiptFromResend = (await resendRes.json()) as EditorReceipt;
    expect(receiptFromResend).toEqual(receiptFromLookup);

    const afterCount = (await listSnapshots(seeded.dir)).length;
    expect(afterCount).toBe(beforeCount + 1); // the resend created NO new snapshot
    await killChild(restarted.child);
  }, 20000);
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Two-process editor race (Issue #110 AC3) -- two SEPARATE server child
// processes sharing one SCADFORGE_PROJECTS_DIR, one request each, so the
// CROSS-PROCESS params lock is what serializes them (a single server
// handling two requests would not prove this).
// ═════════════════════════════════════════════════════════════════════════

describe("two-process editor race", () => {
  it("case A: two different operations at the same base revision -> exactly one commits, one CONFLICT, and the loser's claim is terminal-rejected (never pending)", async () => {
    const projectsDir = await freshProjectsDir();
    const seeded = await seedProject(tracker, projectsDir, [feature(FEATURE_A), feature(FEATURE_B)]);
    const beforeCount = (await listSnapshots(seeded.dir)).length;

    const opA = randomUUID();
    const opB = randomUUID();
    const proofA = await issueRemoveFeatureProof(seeded, FEATURE_A);
    const proofB = await issueRemoveFeatureProof(seeded, FEATURE_B);
    const bodyA = commitRequestFor(seeded, FEATURE_A, opA, proofA);
    const bodyB = commitRequestFor(seeded, FEATURE_B, opB, proofB);

    const serverA = await startServerChild(tracker, projectsDir);
    const serverB = await startServerChild(tracker, projectsDir);

    // Positive overlap evidence (not just Promise.all): both requests are
    // SENT before EITHER response arrives.
    const timers = { sentA: 0, sentB: 0, respondedA: 0, respondedB: 0 };
    const reqA = (async () => {
      timers.sentA = Date.now();
      const res = await postCommand(serverA.baseUrl, seeded.projectId, bodyA);
      timers.respondedA = Date.now();
      return res;
    })();
    const reqB = (async () => {
      timers.sentB = Date.now();
      const res = await postCommand(serverB.baseUrl, seeded.projectId, bodyB);
      timers.respondedB = Date.now();
      return res;
    })();
    const [resA, resB] = await Promise.all([reqA, reqB]);

    expect(Math.max(timers.sentA, timers.sentB)).toBeLessThan(Math.min(timers.respondedA, timers.respondedB));

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const [winnerOp, loserOp] = resA.status === 200 ? [opA, opB] : [opB, opA];
    const { body: winnerBody } = await getOperation(serverA.baseUrl, seeded.projectId, winnerOp);
    expect(winnerBody.state).toBe("committed");

    const { body: loserBody } = await getOperation(serverA.baseUrl, seeded.projectId, loserOp);
    expect(loserBody.state).toBe("definitely_not_committed");
    if (loserBody.state === "definitely_not_committed") {
      expect(loserBody.reason).toBe("rejected"); // never a permanent pending
    }

    const afterCount = (await listSnapshots(seeded.dir)).length;
    expect(afterCount).toBe(beforeCount + 1); // exactly one new snapshot
  }, 20000);

  it("case B: identical operation id and body from two processes -> identical receipts, exactly one snapshot", async () => {
    const projectsDir = await freshProjectsDir();
    const seeded = await seedProject(tracker, projectsDir, [feature(FEATURE_A)]);
    const beforeCount = (await listSnapshots(seeded.dir)).length;

    const operationId = randomUUID();
    const proofId = await issueRemoveFeatureProof(seeded, FEATURE_A);
    const body = commitRequestFor(seeded, FEATURE_A, operationId, proofId);

    const serverA = await startServerChild(tracker, projectsDir);
    const serverB = await startServerChild(tracker, projectsDir);

    const [resA, resB] = await Promise.all([postCommand(serverA.baseUrl, seeded.projectId, body), postCommand(serverB.baseUrl, seeded.projectId, body)]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const receiptA = (await resA.json()) as EditorReceipt;
    const receiptB = (await resB.json()) as EditorReceipt;
    expect(receiptA).toEqual(receiptB);

    const afterCount = (await listSnapshots(seeded.dir)).length;
    expect(afterCount).toBe(beforeCount + 1);
  }, 20000);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Abort-marking failure injection (Issue #110 AC4, carried from the B4
// review) -- see the F4 module-header note for why the intermediate
// assertions go through direct fs reads rather than `lookupClaimLocked`.
// ═════════════════════════════════════════════════════════════════════════

describe("abort-marking failure", () => {
  it("a real, transient claim-marking failure self-heals on the next recovery -- never a permanent pending state", async (ctx) => {
    const projectsDir = await freshProjectsDir();
    const seeded = await seedProject(tracker, projectsDir, [feature(FEATURE_A)]);
    const before = await readRootBytes(seeded.dir);

    const operationId = randomUUID();
    const proofId = await issueRemoveFeatureProof(seeded, FEATURE_A);
    const body = commitRequestFor(seeded, FEATURE_A, operationId, proofId);

    // The crash: staging started (so `abortTransactionLocked`'s row-1 path,
    // which links this operationId's meta.json, is what recovery runs), but
    // no commit.json -- an uncommitted transaction, per the AC's wording.
    const crashing = await startServerChild(tracker, projectsDir, { faultPoint: "after-full-staging" });
    await expect(postCommand(crashing.baseUrl, seeded.projectId, body)).rejects.toThrow();
    await waitForExit(crashing.child, 10000);
    expect(crashing.child.signalCode).toBe("SIGKILL");

    const opsDir = operationsDirOf(seeded.dir);
    const claimPath = join(opsDir, `${operationId}.json`);
    const markerPath = pendingMarkerPathOf(seeded.dir, operationId);

    await chmod(opsDir, 0o555);
    let permissionsRestored = false;
    try {
      // Positive proof the injection actually blocks a write -- never pass vacuously.
      let probeBlocked = false;
      try {
        await writeFile(join(opsDir, `.probe-${randomUUID()}`), "x");
      } catch (err) {
        probeBlocked = (err as NodeJS.ErrnoException).code === "EACCES";
      }
      if (!probeBlocked) {
        await chmod(opsDir, 0o755);
        permissionsRestored = true;
        console.warn(
          "[abort-marking-failure SKIPPED] chmod 0o555 did not block a write into operationsDir " +
            "(likely running as root) -- cannot inject this failure in this environment."
        );
        ctx.skip();
        return;
      }

      // While blocked: the recovery boundary itself is unusable (F4) --
      // positive evidence the injected failure actually reached
      // recordClaimAbortedLocked's write, not merely that SOMETHING failed.
      await expect(withRecoveredProject(seeded.dir, (ctx2) => lookupClaimLocked(ctx2, operationId))).rejects.toMatchObject({
        error_code: "INTERNAL_ERROR"
      });

      const markerExists = await pathExists(markerPath);
      expect(markerExists).toBe(true); // never cleared while the write fails
      const claim = JSON.parse(await readFile(claimPath, "utf8")) as { terminal: unknown };
      expect(claim.terminal).toBeNull(); // never a permanent pending -- but not yet resolved either
      const rootWhileBlocked = await readRootBytes(seeded.dir);
      expect(rootWhileBlocked).toEqual(before);
    } finally {
      if (!permissionsRestored) await chmod(opsDir, 0o755); // ALWAYS restored, even on assertion failure
    }

    // Unblocked: the pending-marker sweep retries on the very next boundary
    // entry and succeeds this time.
    const lookup = await withRecoveredProject(seeded.dir, (ctx2) => lookupClaimLocked(ctx2, operationId));
    expect(lookup.kind).toBe("definitely_not_committed");
    if (lookup.kind === "definitely_not_committed") expect(lookup.reason).toBe("aborted");
    const markerGone = await pathExists(markerPath);
    expect(markerGone).toBe(false);
  }, 15000);
});
