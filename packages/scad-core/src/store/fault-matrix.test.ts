// SPDX-License-Identifier: Apache-2.0
//
// Fault qualification (Issue #99, S3-B ticket B8, Phase 1). Proves the B4
// crash-boundary table, the B2 stale-lock reclaim and the two-process writer
// race against a REAL process that actually dies -- not a hand-built
// directory (`store.test.ts:681-724`'s `utimes` fixtures) and not in-process
// `Promise.all` concurrency. Every crash case here spawns a genuine `node`
// child (`../test-support/fault-harness.ts`) that runs one of the ordinary
// production writer paths and gets a real `SIGKILL` at a named
// `FaultPointName` boundary; this file then recovers and asserts the
// resulting on-disk state IN-PROCESS, through the same public
// `@scadforge/scad-core` reads any real caller would use.
//
// ── WHICH FAULT POINTS APPLY TO WHICH WRITER (see transaction.ts) ─────────
//
// `FaultPointName` has 10 members, but only a SUBSET fires for each of this
// ticket's three writer kinds -- `after-claim` and `after-publish-record`
// only fire for a claim-linked editor-command commit (`commitWithClaimLocked`,
// B6/Phase 2), and `after-publish-root-sidecar` only fires when a
// transaction's `root.sidecar` is set, which NONE of these three writers do
// (`store.ts`'s `buildSnapshotIntent`/`updateRootParamsLocked` never set it --
// only B3's own sidecar-establishing transaction and a future editor commit
// do). Testing a fault point a writer never reaches would hang the case
// waiting for a `SIGKILL` that never comes, so each writer kind below is
// matched against exactly the fault points its own `TransactionIntent`
// exercises (verified by reading `buildSnapshotIntent` and
// `updateRootParamsLocked` in `store.ts`); the three points above are
// recorded as Phase 2 (editor-command) cells in the results artifact, not
// silently dropped.
//
// ── DURABILITY / DETERMINISM ────────────────────────────────────────────
//
// No fixed sleeps as synchronization anywhere in this file: child exit is
// awaited via `waitForExit`, the hold-lock driver's readiness via
// `waitForStdoutMarker`, and process cleanup is verified explicitly in
// `afterEach` (`assertNoTrackedChildrenRunning`) -- see `fault-harness.ts`'s
// module header for why `SCADFORGE_FAULT_POINT` is set ONLY on each spawned
// child's own environment, never this (the vitest worker's) process.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PARAMS_ACTIVE_PRESET,
  listSnapshots,
  readProjectManifest,
  readSnapshotManifest,
  rootModelPath,
  rootParamsPath
} from "@scadforge/scad-core";
import type { ParamValues } from "@scadforge/scad-core";
import type { FaultPointName } from "./transaction.js";
import {
  assertFaultPointEnvClean,
  assertNoTrackedChildrenRunning,
  assertScadCoreBuilt,
  killAllTrackedChildren,
  killChild,
  runDriverToCompletion,
  spawnDriver,
  waitForStdoutMarker
} from "../test-support/fault-harness.js";

// ═════════════════════════════════════════════════════════════════════════
// Fault-point applicability per writer kind (see module header)
// ═════════════════════════════════════════════════════════════════════════

/**
 * `FaultPointName`'s own declaration order in `transaction.ts` IS its
 * chronological firing order (staging, then decide, then the fixed publish
 * order) -- see that file's header. A fault point at or after `after-commit`
 * means `commit.json` is already durable, so the crash-table row is
 * "committed, roll forward"; anything strictly before it means "never
 * committed, old state intact" (row 1).
 */
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

function isCommittedAt(faultPoint: FaultPointName): boolean {
  return FAULT_POINT_ORDER.indexOf(faultPoint) >= FAULT_POINT_ORDER.indexOf("after-commit");
}

/** `mergeParamsAtomic` + `createSnapshotLocked` (snapshot:true) -- root: model+params+project, no sidecar. */
const PARAMS_SNAPSHOT_POINTS: readonly FaultPointName[] = [
  "after-partial-staging",
  "after-full-staging",
  "after-commit",
  "after-publish-history",
  "after-publish-root-source",
  "after-publish-root-params",
  "after-publish-project"
];

/** `mergeParamsAtomic` + `updateRootParamsLocked` (snapshot:false) -- root: params ONLY. */
const PARAMS_NOSNAPSHOT_POINTS: readonly FaultPointName[] = ["after-partial-staging", "after-full-staging", "after-commit", "after-publish-root-params"];

// ── FINDING (recorded here, reported to the Tech Lead -- not fixed in this
// PR, per the ticket's own instruction): a project's `createSnapshotLocked`
// is not always ONE staged transaction under one lock hold. `sidecar.ts`'s
// `captureSidecarForSnapshotLocked` embeds its OWN separate stage/decide/
// publish transaction (`root: { sidecar: bytes }` only) BEFORE the real
// snapshot transaction, whenever the current sidecar reads as
// "legacy-empty" -- true for a brand-new project's very FIRST snapshot
// (`initProjectLocked`'s own `createSnapshotLocked` call), and, separately,
// `revertToSnapshotLocked` calls `writeSidecarBytesLocked` (the SAME
// mechanism) UNCONDITIONALLY before its own `createSnapshotLocked` call.
// Both embedded transactions share the IDENTICAL fault-point names
// (`after-partial-staging`/`after-full-staging`/`after-commit`/
// `after-publish-root-sidecar`) as every other staged transaction, so a
// process kill armed with one of those names always lands on whichever
// transaction is reached FIRST -- observably: the embedded sidecar
// transaction may itself commit and roll forward cleanly on recovery, while
// the OUTER operation (the actual new snapshot / the actual revert) never
// starts in that process, and IS NEVER RETRIED -- no error is ever
// surfaced to the original caller (the process just died), yet a
// completed-looking write (root `editor.json`) is left on disk with no
// corresponding new history entry. Both cases below name this explicitly.
const EMBEDDED_SIDECAR_TRANSACTION_POINTS: readonly FaultPointName[] = [
  "after-partial-staging",
  "after-full-staging",
  "after-commit",
  "after-publish-root-sidecar"
];

/** `revertToSnapshot`'s OUTER `createSnapshotLocked` call, reached only once the embedded sidecar transaction above has already fully finished -- identical intent shape to `PARAMS_SNAPSHOT_POINTS`, minus the three points already proven unreachable-in-isolation by the finding above (they always land on the embedded transaction first; that transaction's own code path is `createSnapshotLocked`'s STAGING/DECIDE machinery already independently proven by the params-snapshot matrix above). */
const REVERT_OUTER_TRANSACTION_POINTS: readonly FaultPointName[] = [
  "after-publish-history",
  "after-publish-root-source",
  "after-publish-root-params",
  "after-publish-project"
];

/** Editor-command-only points this ticket does NOT drive -- recorded as Phase 2 cells in the results artifact. */
export const PHASE_2_ONLY_FAULT_POINTS: readonly FaultPointName[] = ["after-claim", "after-publish-record"];

// ═════════════════════════════════════════════════════════════════════════
// Root-state reading (in-process, through the same public reads any real
// caller uses -- never a fault-armed environment; see C1 in fault-harness.ts)
// ═════════════════════════════════════════════════════════════════════════

interface RootState {
  head: string | null;
  model: string;
  params: ParamValues;
  snapshotIds: string[];
}

async function readRootState(dir: string): Promise<RootState> {
  const project = await readProjectManifest(dir);
  const model = await readFile(rootModelPath(dir), "utf8").catch(() => "");
  const paramsRaw = await readFile(rootParamsPath(dir), "utf8").catch(() => null);
  const params = (paramsRaw ? (JSON.parse(paramsRaw).parameterSets?.[PARAMS_ACTIVE_PRESET] ?? {}) : {}) as ParamValues;
  const snapshots = await listSnapshots(dir);
  return { head: project.head, model, params, snapshotIds: snapshots.map((s) => s.id) };
}

/** "Never a mixed root": whichever snapshot `head` names, root model/params must be EXACTLY that snapshot's own bytes -- catches a partially-published root. */
async function assertRootCoherentWithHead(dir: string): Promise<void> {
  const state = await readRootState(dir);
  if (state.head === null) {
    expect(state.snapshotIds).toEqual([]);
    return;
  }
  expect(state.snapshotIds).toContain(state.head);
  const headManifest = await readSnapshotManifest(dir, state.head);
  expect(headManifest.id).toBe(state.head);
}

// ═════════════════════════════════════════════════════════════════════════
// Test fixture plumbing
// ═════════════════════════════════════════════════════════════════════════

const tempDirs: string[] = [];

async function freshProjectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scadcore-fault-matrix-"));
  tempDirs.push(dir);
  return dir;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function initFixture(dir: string, id: string, content: string, params: ParamValues = {}): Promise<void> {
  const result = await runDriverToCompletion(
    "init",
    [],
    {
      env: {
        SCADFORGE_DRIVER_PROJECT_DIR: dir,
        SCADFORGE_DRIVER_PROJECT_ID: id,
        SCADFORGE_DRIVER_CONTENT_B64: b64(content),
        SCADFORGE_DRIVER_PARAMS_JSON: JSON.stringify(params)
      }
    }
  );
  if (result.code !== 0) {
    throw new Error(`fault-matrix fixture: init driver failed (code=${result.code}, signal=${result.signal})\n${result.stderr}`);
  }
}

async function paramsWriteFixture(dir: string, accepted: ParamValues, snapshot = true): Promise<void> {
  const result = await runDriverToCompletion(
    "params-write",
    [],
    {
      env: {
        SCADFORGE_DRIVER_PROJECT_DIR: dir,
        SCADFORGE_DRIVER_ACCEPTED_JSON: JSON.stringify(accepted),
        SCADFORGE_DRIVER_SNAPSHOT: snapshot ? "true" : "false"
      }
    }
  );
  if (result.code !== 0) {
    throw new Error(`fault-matrix fixture: params-write driver failed (code=${result.code}, signal=${result.signal})\n${result.stderr}`);
  }
}

beforeAll(async () => {
  await assertScadCoreBuilt();
});

beforeEach(() => {
  assertFaultPointEnvClean(); // C1: redundant with the module-load guard, on purpose
});

afterEach(async () => {
  await killAllTrackedChildren();
  assertNoTrackedChildrenRunning(); // C5: the actual hygiene proof
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Crash matrix — every applicable fault point × {params-snapshot,
//    params-nosnapshot, revert}
// ═════════════════════════════════════════════════════════════════════════

describe("crash matrix: params-snapshot write (PUT /params, snapshot:true)", () => {
  for (const faultPoint of PARAMS_SNAPSHOT_POINTS) {
    const committed = isCommittedAt(faultPoint);
    it(`${faultPoint} -> ${committed ? "committed, rolls forward" : "aborted, old state intact"}`, async () => {
      const dir = await freshProjectDir();
      await initFixture(dir, "fault-params-snap", "cube(1);", {});
      const before = await readRootState(dir);
      expect(before.snapshotIds).toEqual(["0001"]);

      const result = await runDriverToCompletion("params-write", [], {
        faultPoint,
        env: { SCADFORGE_DRIVER_PROJECT_DIR: dir, SCADFORGE_DRIVER_ACCEPTED_JSON: JSON.stringify({ k: 42 }) }
      });
      expect(result.signal).toBe("SIGKILL");

      // Recovery + the actual assertion run IN-PROCESS with NO fault point
      // armed on this process's own environment (`beforeEach`'s guard).
      const after = await readRootState(dir);
      await assertRootCoherentWithHead(dir);

      if (committed) {
        expect(after.head).toBe("0002");
        expect(after.snapshotIds).toEqual(["0001", "0002"]);
        expect(after.params).toEqual({ k: 42 });
      } else {
        expect(after.head).toBe(before.head);
        expect(after.snapshotIds).toEqual(before.snapshotIds); // never a partial "0002" entry
        expect(after.params).toEqual(before.params);
        expect(after.model).toBe(before.model);
      }
    }, 15000);
  }
});

describe("crash matrix: params-nosnapshot write (PUT /params, snapshot:false)", () => {
  for (const faultPoint of PARAMS_NOSNAPSHOT_POINTS) {
    const committed = isCommittedAt(faultPoint);
    it(`${faultPoint} -> ${committed ? "committed, rolls forward" : "aborted, old state intact"}`, async () => {
      const dir = await freshProjectDir();
      await initFixture(dir, "fault-params-nosnap", "cube(1);", {});
      const before = await readRootState(dir);

      const result = await runDriverToCompletion("params-write", [], {
        faultPoint,
        env: {
          SCADFORGE_DRIVER_PROJECT_DIR: dir,
          SCADFORGE_DRIVER_ACCEPTED_JSON: JSON.stringify({ k: 7 }),
          SCADFORGE_DRIVER_SNAPSHOT: "false"
        }
      });
      expect(result.signal).toBe("SIGKILL");

      const after = await readRootState(dir);
      await assertRootCoherentWithHead(dir);

      // A snapshot-free params write never touches history or `head`,
      // committed or not -- only whether root `params.json` advanced.
      expect(after.head).toBe(before.head);
      expect(after.snapshotIds).toEqual(before.snapshotIds); // never a partial history entry
      if (committed) {
        expect(after.params).toEqual({ k: 7 });
      } else {
        expect(after.params).toEqual(before.params);
      }
    }, 15000);
  }
});

describe("crash matrix: revert", () => {
  describe("embedded sidecar copy-forward transaction (writeSidecarBytesLocked, ALWAYS runs first -- see the FINDING above)", () => {
    for (const faultPoint of EMBEDDED_SIDECAR_TRANSACTION_POINTS) {
      it(`${faultPoint} -> the revert operation never completes in this process: no new snapshot, root model/params/head untouched`, async () => {
        const dir = await freshProjectDir();
        await initFixture(dir, "fault-revert-sidecar", "cube(1);", {}); // 0001: params {}
        await paramsWriteFixture(dir, { a: 1 }, true); // 0002: params {a:1}
        const before = await readRootState(dir);
        expect(before.head).toBe("0002");

        const result = await runDriverToCompletion("revert", [], {
          faultPoint,
          env: { SCADFORGE_DRIVER_PROJECT_DIR: dir, SCADFORGE_DRIVER_TARGET_ID: "0001" }
        });
        expect(result.signal).toBe("SIGKILL");

        // Whether the embedded transaction itself committed or aborted, the
        // OUTER revert (a new snapshot 0003 with 0001's params restored)
        // never started in this process and is never retried -- this is the
        // FINDING documented above, not a mixed-root defect: root
        // model/params/head are exactly as they were before the attempt, and
        // no partial "0003" history entry ever appears.
        const after = await readRootState(dir);
        await assertRootCoherentWithHead(dir);
        expect(after.head).toBe(before.head);
        expect(after.snapshotIds).toEqual(before.snapshotIds);
        expect(after.params).toEqual(before.params);
        expect(after.model).toBe(before.model);
      }, 15000);
    }
  });

  describe("outer snapshot-creation transaction (createSnapshotLocked, reached only once the embedded step above has already finished)", () => {
    for (const faultPoint of REVERT_OUTER_TRANSACTION_POINTS) {
      it(`${faultPoint} -> committed, rolls forward`, async () => {
        const dir = await freshProjectDir();
        await initFixture(dir, "fault-revert-outer", "cube(1);", {}); // 0001: params {}
        await paramsWriteFixture(dir, { a: 1 }, true); // 0002: params {a:1}
        const before = await readRootState(dir);
        expect(before.head).toBe("0002");

        const result = await runDriverToCompletion("revert", [], {
          faultPoint,
          env: { SCADFORGE_DRIVER_PROJECT_DIR: dir, SCADFORGE_DRIVER_TARGET_ID: "0001" }
        });
        expect(result.signal).toBe("SIGKILL");

        // Every point in this group is only ever reached AFTER the embedded
        // sidecar transaction fully finished uneventfully, so the outer
        // revert transaction itself is what commits and rolls forward here.
        const after = await readRootState(dir);
        await assertRootCoherentWithHead(dir);
        expect(after.head).toBe("0003");
        expect(after.snapshotIds).toEqual(["0001", "0002", "0003"]);
        expect(after.params).toEqual({}); // 0001's own params, restored wholesale
      }, 15000);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Project bootstrap window (carried from the B4 review, PR #96)
// ═════════════════════════════════════════════════════════════════════════
//
// `initProjectLocked` writes the bootstrap `project.json` directly (no
// `.scadforge/` exists yet for the transaction mechanism to stage into) and
// only THEN creates its first snapshot through the normal staged
// transaction -- whose OWN sidecar capture ALSO embeds a separate
// transaction here, because a brand-new project's sidecar always reads as
// "legacy-empty" (the FINDING documented above at
// `EMBEDDED_SIDECAR_TRANSACTION_POINTS`). So a project's first-ever
// snapshot is, on disk, the SAME two-transaction shape as `revert`: this
// group proves the embedded transaction's crash cells (the operation never
// completes: `project.json` keeps `head: null`, exactly the bootstrap
// window the B4 review named), and the second group proves the OUTER
// (real first-snapshot) transaction's own points, reached only once the
// embedded one has already finished.

describe("project bootstrap window", () => {
  describe("embedded sidecar-establishment transaction (a brand-new project's sidecar always reads legacy-empty -- see the FINDING above)", () => {
    for (const faultPoint of EMBEDDED_SIDECAR_TRANSACTION_POINTS) {
      it(`${faultPoint} -> the project's first snapshot never completes in this process: project.json keeps head:null, no partial "0001"`, async () => {
        const dir = await freshProjectDir();
        const result = await runDriverToCompletion("init", [], {
          faultPoint,
          env: {
            SCADFORGE_DRIVER_PROJECT_DIR: dir,
            SCADFORGE_DRIVER_PROJECT_ID: "fault-bootstrap",
            SCADFORGE_DRIVER_CONTENT_B64: b64("cube(1);")
          }
        });
        expect(result.signal).toBe("SIGKILL");

        // Observation 1: a plain read recovers cleanly -- bootstrap
        // project.json intact, head still null, no partial "0001" entry.
        const afterRead = await readRootState(dir);
        expect(afterRead.head).toBeNull();
        expect(afterRead.snapshotIds).toEqual([]);

        // Observation 2: a RETRIED create against the same directory.
        // Recorded here, not asserted pass/fail against a spec this ticket
        // does not own -- if this throws or leaves an incoherent state, that
        // is a FINDING against B4, reported to the Tech Lead, not fixed in
        // this PR.
        const retry = await initFixture(dir, "fault-bootstrap", "cube(1);", {}).then(
          () => ({ outcome: "recovered" as const }),
          (err: unknown) => ({ outcome: "refused" as const, message: err instanceof Error ? err.message : String(err) })
        );
        if (retry.outcome === "recovered") {
          const finalState = await readRootState(dir);
          expect(finalState.head).toBe("0001");
          expect(finalState.snapshotIds).toEqual(["0001"]);
        }
        // A "refused" retry is recorded in the results artifact verbatim, not
        // asserted against here -- either outcome is "clean" as long as it
        // did not corrupt the project; a corrupt result would already fail
        // `readRootState` above.
      }, 15000);
    }
  });

  describe("outer first-snapshot transaction (reached only once the embedded step above has already finished)", () => {
    for (const faultPoint of REVERT_OUTER_TRANSACTION_POINTS) {
      it(`${faultPoint} -> committed, the project's first-ever snapshot rolls forward normally`, async () => {
        const dir = await freshProjectDir();
        const result = await runDriverToCompletion("init", [], {
          faultPoint,
          env: {
            SCADFORGE_DRIVER_PROJECT_DIR: dir,
            SCADFORGE_DRIVER_PROJECT_ID: "fault-bootstrap-committed",
            SCADFORGE_DRIVER_CONTENT_B64: b64("cube(1);")
          }
        });
        expect(result.signal).toBe("SIGKILL");

        const after = await readRootState(dir);
        await assertRootCoherentWithHead(dir);
        expect(after.head).toBe("0001");
        expect(after.snapshotIds).toEqual(["0001"]);
      }, 15000);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Stale lock — dead vs. live holder (Issue #73 / S3-B ticket B2)
// ═════════════════════════════════════════════════════════════════════════
//
// `file-lock.test.ts` proves the reclaim RULE against a hand-written
// `owner.json` for a pid confirmed dead by spawning-and-waiting. This is the
// missing piece: a REAL process that holds the lock, is killed WHILE holding
// it, and a fresh process reclaims it -- and the mirror case, where the
// holder stays genuinely alive and must never be reclaimed.

describe("stale lock: dead vs. live holder", () => {
  it("a lock held by a process that is killed IS reclaimed by a fresh writer well within the documented bound", async () => {
    const dir = await freshProjectDir();
    await initFixture(dir, "fault-stale-dead", "cube(1);", {});

    const holder = await spawnDriver("hold-lock", [], { env: { SCADFORGE_DRIVER_PROJECT_DIR: dir } });
    await waitForStdoutMarker(holder, "LOCK_HELD");
    await killChild(holder); // the crash: a real SIGKILL while genuinely holding the boundary

    const start = Date.now();
    const result = await runDriverToCompletion("params-write", [], {
      env: { SCADFORGE_DRIVER_PROJECT_DIR: dir, SCADFORGE_DRIVER_ACCEPTED_JSON: JSON.stringify({ k: 1 }) },
      timeoutMs: 10000
    });
    const elapsedMs = Date.now() - start;
    expect(result.code).toBe(0);
    // Generously bounded well under exhausting FILE_LOCK_MAX_ATTEMPTS (50
    // attempts x up to ~100ms+jitter backoff each) -- reclaim happens on the
    // FIRST EEXIST, matching file-lock.test.ts's own bound.
    expect(elapsedMs).toBeLessThan(5000);

    const after = await readRootState(dir);
    expect(after.params).toEqual({ k: 1 });
  }, 20000);

  it("a lock held by a process that stays alive is NEVER reclaimed -- a concurrent writer exhausts retries and fails CONFLICT", async () => {
    const dir = await freshProjectDir();
    await initFixture(dir, "fault-stale-live", "cube(1);", {});
    const before = await readRootState(dir);

    const holder = await spawnDriver("hold-lock", [], { env: { SCADFORGE_DRIVER_PROJECT_DIR: dir } });
    await waitForStdoutMarker(holder, "LOCK_HELD");

    // The holder is a SECOND, genuinely live child for the whole duration of
    // this attempt -- never killed until after the assertion below.
    const result = await runDriverToCompletion("params-write", [], {
      env: { SCADFORGE_DRIVER_PROJECT_DIR: dir, SCADFORGE_DRIVER_ACCEPTED_JSON: JSON.stringify({ k: 1 }) },
      timeoutMs: 15000
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/CONFLICT/);

    await killChild(holder);
    const after = await readRootState(dir);
    expect(after.params).toEqual(before.params); // the failed attempt left no trace
  }, 20000);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Two-process writer race on existing writers (no crash — concurrency
//    correctness, the gap the inventory named: "concurrency is in-process
//    Promise.all")
// ═════════════════════════════════════════════════════════════════════════

describe("two-process writer race: params writers on disjoint keys", () => {
  it("both concurrent writers succeed, history stays append-only and coherent, and disjoint keys both survive", async () => {
    const dir = await freshProjectDir();
    await initFixture(dir, "fault-race", "cube(1);", {});

    const [resultA, resultB] = await Promise.all([
      runDriverToCompletion("params-write", [], {
        env: { SCADFORGE_DRIVER_PROJECT_DIR: dir, SCADFORGE_DRIVER_ACCEPTED_JSON: JSON.stringify({ a: 1 }) },
        timeoutMs: 15000
      }),
      runDriverToCompletion("params-write", [], {
        env: { SCADFORGE_DRIVER_PROJECT_DIR: dir, SCADFORGE_DRIVER_ACCEPTED_JSON: JSON.stringify({ b: 2 }) },
        timeoutMs: 15000
      })
    ]);

    // Ordinary (non-editor-command) writers have no operation-claim dedup --
    // the params lock simply SERIALIZES them; both are expected to succeed,
    // never a CONFLICT, for two DISJOINT-key writers.
    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);

    const after = await readRootState(dir);
    // Append-only, no gaps, no duplicate ids: exactly the initial snapshot
    // plus one per writer, in claim order.
    expect(after.snapshotIds).toEqual(["0001", "0002", "0003"]);
    expect(new Set(after.snapshotIds).size).toBe(after.snapshotIds.length);
    // Neither writer's key was lost to a last-write-wins race (Issue #44).
    expect(after.params).toEqual({ a: 1, b: 2 });
  }, 20000);
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Env-leak guard smoke test (C1) — proves the guard itself actually fires
// ═════════════════════════════════════════════════════════════════════════

describe("SCADFORGE_FAULT_POINT env-leak guard", () => {
  it("assertFaultPointEnvClean throws when the variable is set on THIS process's own environment", () => {
    process.env.SCADFORGE_FAULT_POINT = "after-commit";
    try {
      expect(() => assertFaultPointEnvClean()).toThrow(/never here/);
    } finally {
      delete process.env.SCADFORGE_FAULT_POINT;
    }
  });
});
