// SPDX-License-Identifier: Apache-2.0
//
// Staged roll-forward transactions (Issue #90, S3-B ticket B4). Exercises
// `transaction.ts`'s stage → decide → publish primitives and recovery
// directly, plus the claims module's reserve/replay rules — all against a
// hand-built project skeleton, decoupled from `store.ts` (mirrors
// `sidecar.test.ts`/`recovered.test.ts`'s own isolation convention).

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectManifest } from "@scadforge/protocol";
import { canonicalJson } from "../editor/canonical.js";
import { EMPTY_SIDECAR } from "../editor/sidecar-empty.js";
import {
  historyDir,
  metaDir,
  operationPath,
  projectFilePath,
  quarantineDir,
  rootModelPath,
  rootParamsPath,
  sidecarPath,
  snapshotDir,
  transactionDir
} from "./paths.js";
import { withRecoveredProject } from "./recovered.js";
import type { LockedProject } from "./recovered.js";
import {
  ABORTED_REPLAY_MESSAGE,
  decideReplay,
  lookupClaimLocked,
  recordClaimAbortedLocked,
  reserveClaimLocked
} from "./claims.js";
import {
  __setFaultActionForTests,
  abortTransactionLocked,
  decideLocked,
  faultPoint,
  publishLocked,
  reconcileTransactionLocked,
  stageTransactionLocked,
  type TransactionIntent
} from "./transaction.js";

const PROVIDER = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-transaction-test-"));
  await mkdir(metaDir(projectDir), { recursive: true });
  await mkdir(historyDir(projectDir), { recursive: true });
  const manifest: ProjectManifest = {
    schema_version: 1,
    id: "hinged-box", // real project ids are slugs, never a fabricated UUID (known S3-A contract gap on projectId)
    name: "Test",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    openscad_image: "openscad/openscad@sha256:test",
    openscad_version: "2026.01.19",
    provider: PROVIDER,
    head: null,
    editor_store_version: 1
  };
  await writeFile(projectFilePath(projectDir), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(rootModelPath(projectDir), "cube(1);\n", "utf8");
  await writeFile(rootParamsPath(projectDir), JSON.stringify({ fileFormatVersion: "1", parameterSets: { current: {} } }, null, 2), "utf8");
  await writeFile(sidecarPath(projectDir), canonicalJson(EMPTY_SIDECAR), "utf8");
});

afterEach(async () => {
  __setFaultActionForTests(null); // never leak a test's fault stand-in into the next test
  delete process.env.SCADFORGE_FAULT_POINT;
  await rm(projectDir, { recursive: true, force: true });
});

function withCtx<T>(fn: (ctx: LockedProject) => Promise<T>): Promise<T> {
  return withRecoveredProject(projectDir, fn);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// stage → decide → publish
// ═════════════════════════════════════════════════════════════════════════════

describe("stageTransactionLocked / decideLocked / publishLocked", () => {
  it("stages without touching any authoritative file; nothing changes until publish", async () => {
    await withCtx(async (ctx) => {
      const intent: TransactionIntent = { transactionId: randomUUID(), root: { model: "cube(2);\n" } };
      const staged = await stageTransactionLocked(ctx, intent);
      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe("cube(1);\n");
      expect(await readFile(join(staged.dir, "root", "model.scad"), "utf8")).toBe("cube(2);\n");

      const decided = await decideLocked(ctx, staged);
      // decideLocked writes commit.json but STILL never touches the root file.
      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe("cube(1);\n");
      expect(decided.decision.files["root/model.scad"]).toMatch(/^[0-9a-f]{64}$/);

      await publishLocked(ctx, decided);
      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe("cube(2);\n");
      expect(await pathExists(staged.dir)).toBe(false); // redundant staging cleaned up
    });
  });

  it("commit.json digests are plain SHA-256 of exact bytes, not B1's canonical-JSON digest -- a non-JSON model.scad stages, decides and publishes fine (Tech Lead correction C1)", async () => {
    const notJson = "difference() { cube(3); sphere(1); } // not JSON at all\n";
    await withCtx(async (ctx) => {
      const intent: TransactionIntent = { transactionId: randomUUID(), root: { model: notJson } };
      const staged = await stageTransactionLocked(ctx, intent);
      const decided = await decideLocked(ctx, staged); // must not throw
      await publishLocked(ctx, decided);
      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe(notJson);
    });
  });

  it("publishLocked is idempotent -- re-running it against an already-fully-published decision is a no-op, even after the staging directory is gone", async () => {
    await withCtx(async (ctx) => {
      const intent: TransactionIntent = { transactionId: randomUUID(), root: { model: "cube(4);\n" } };
      const staged = await stageTransactionLocked(ctx, intent);
      const decided = await decideLocked(ctx, staged);
      await publishLocked(ctx, decided);
      await expect(publishLocked(ctx, decided)).resolves.toBeUndefined();
      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe("cube(4);\n");
    });
  });

  it("publishes root + a full snapshot together, and history/<id> exists complete afterward", async () => {
    await withCtx(async (ctx) => {
      const manifest = {
        id: "0001",
        parent: null,
        timestamp: new Date().toISOString(),
        message: "first",
        origin: "manual" as const,
        pass: null,
        files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
        params: {},
        renders: [],
        validation: null,
        annotations: [],
        editor: { version: 1 as const, file: "editor.json" as const, sha256: "a".repeat(64) }
      };
      const intent: TransactionIntent = {
        transactionId: randomUUID(),
        root: {
          model: "cube(5);\n",
          params: { fileFormatVersion: "1", parameterSets: { current: {} } }
        },
        snapshot: {
          id: "0001",
          manifest,
          model: "cube(5);\n",
          params: { fileFormatVersion: "1", parameterSets: { current: {} } },
          message: "first",
          diff: null,
          validation: null,
          sidecar: canonicalJson(EMPTY_SIDECAR),
          renders: []
        }
      };
      await mkdir(snapshotDir(projectDir, "0001")); // the id claim: an empty directory (mirrors claimNextSnapshotId)
      const staged = await stageTransactionLocked(ctx, intent);
      const decided = await decideLocked(ctx, staged);
      await publishLocked(ctx, decided);

      const publishedManifest = JSON.parse(await readFile(join(snapshotDir(projectDir, "0001"), "manifest.json"), "utf8"));
      expect(publishedManifest.id).toBe("0001");
      expect(await readFile(join(snapshotDir(projectDir, "0001"), "model.scad"), "utf8")).toBe("cube(5);\n");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fault points (Issue #90 AC8)
// ═════════════════════════════════════════════════════════════════════════════

describe("faultPoint", () => {
  it("is inert without SCADFORGE_FAULT_POINT set", async () => {
    await expect(faultPoint("after-commit")).resolves.toBeUndefined();
  });

  it("fires the (test-only) fault action only when the env var names this exact point", async () => {
    let fired = 0;
    __setFaultActionForTests(() => {
      fired++;
      throw new Error("simulated crash");
    });
    process.env.SCADFORGE_FAULT_POINT = "after-commit";
    await expect(faultPoint("after-commit")).rejects.toThrow("simulated crash");
    expect(fired).toBe(1);
    await expect(faultPoint("after-publish-project")).resolves.toBeUndefined(); // a DIFFERENT name never fires
    expect(fired).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Crash-boundary recovery (Issue #90 AC4)
// ═════════════════════════════════════════════════════════════════════════════

describe("recovery: staging without commit.json (crash-table row 1)", () => {
  it("aborts: quarantines the staging directory, leaves root/history untouched, and no directory is left under editor-transactions/", async () => {
    await withCtx(async (ctx) => {
      const transactionId = randomUUID();
      const intent: TransactionIntent = { transactionId, root: { model: "cube(9);\n" } };
      await stageTransactionLocked(ctx, intent); // staged, never decided -- simulates a crash before commit.json
      expect(await pathExists(transactionDir(projectDir, transactionId))).toBe(true);

      await reconcileTransactionLocked(ctx, transactionId);

      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe("cube(1);\n"); // untouched
      expect(await pathExists(transactionDir(projectDir, transactionId))).toBe(false);
      const quarantined = await readdir(quarantineDir(projectDir));
      expect(quarantined.some((name) => name.includes(`tx-${transactionId}`))).toBe(true);
    });
  });

  it("removes the claimed empty history/<id> directory, but ONLY when it is still empty (Tech Lead approved correction)", async () => {
    await withCtx(async (ctx) => {
      const transactionId = randomUUID();
      const manifest = {
        id: "0002",
        parent: null,
        timestamp: new Date().toISOString(),
        message: "",
        origin: "manual" as const,
        pass: null,
        files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
        params: {},
        renders: [],
        validation: null,
        annotations: [],
        editor: { version: 1 as const, file: "editor.json" as const, sha256: "b".repeat(64) }
      };
      const intent: TransactionIntent = {
        transactionId,
        root: { model: "cube(9);\n" },
        snapshot: {
          id: "0002",
          manifest,
          model: "cube(9);\n",
          params: { fileFormatVersion: "1", parameterSets: { current: {} } },
          message: "",
          diff: null,
          validation: null,
          sidecar: canonicalJson(EMPTY_SIDECAR),
          renders: []
        }
      };
      await mkdir(snapshotDir(projectDir, "0002")); // the claimed, still-empty directory
      await stageTransactionLocked(ctx, intent);

      await reconcileTransactionLocked(ctx, transactionId, "0002");

      expect(await pathExists(snapshotDir(projectDir, "0002"))).toBe(false); // reclaimed -- an id gap, never a partial entry
    });
  });

  it("never removes a NON-EMPTY claimed directory", async () => {
    await withCtx(async (ctx) => {
      await mkdir(snapshotDir(projectDir, "0003"));
      await writeFile(join(snapshotDir(projectDir, "0003"), "sentinel.txt"), "must survive", "utf8");
      await abortTransactionLocked(ctx, randomUUID(), "0003"); // no transaction dir at all -- simulates a crash before staging even began
      expect(await readFile(join(snapshotDir(projectDir, "0003"), "sentinel.txt"), "utf8")).toBe("must survive");
    });
  });

  it("marks a linked claim aborted", async () => {
    await withCtx(async (ctx) => {
      await reserveClaimLocked(ctx, "11111111-1111-4111-8111-111111111111", "digest-1", { hello: "world" });
      const transactionId = randomUUID();
      const intent: TransactionIntent = {
        transactionId,
        root: { model: "cube(9);\n" },
        claim: { operationId: "11111111-1111-4111-8111-111111111111" }
      };
      await stageTransactionLocked(ctx, intent); // never decided
      await reconcileTransactionLocked(ctx, transactionId);

      const looked = await lookupClaimLocked(ctx, "11111111-1111-4111-8111-111111111111");
      expect(looked).toMatchObject({ kind: "definitely_not_committed", reason: "aborted" });
    });
  });
});

describe("recovery: commit.json present (crash-table rows 2/3/4)", () => {
  it("finishes an idempotent republish when publication was only partial", async () => {
    await withCtx(async (ctx) => {
      const intent: TransactionIntent = { transactionId: randomUUID(), root: { model: "cube(10);\n" } };
      const staged = await stageTransactionLocked(ctx, intent);
      await decideLocked(ctx, staged); // commit.json now durable
      // Simulate a crash right after decide, before ANY publish step ran --
      // do NOT call publishLocked. `reconcileTransactionLocked` (what a
      // fresh boundary entry's `recover()` would run) must finish it.
      await reconcileTransactionLocked(ctx, intent.transactionId);
      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe("cube(10);\n");
      expect(await pathExists(staged.dir)).toBe(false);
    });
  });

  it("refuses with INTERNAL_ERROR and deletes nothing when a required staged file was tampered with after decision", async () => {
    await withCtx(async (ctx) => {
      const intent: TransactionIntent = { transactionId: randomUUID(), root: { model: "cube(11);\n" } };
      const staged = await stageTransactionLocked(ctx, intent);
      await decideLocked(ctx, staged);
      await writeFile(join(staged.dir, "root", "model.scad"), "TAMPERED\n", "utf8");

      await expect(reconcileTransactionLocked(ctx, intent.transactionId)).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });

      // Nothing deleted: root untouched, staging directory (tampered bytes included) preserved for inspection.
      expect(await readFile(rootModelPath(projectDir), "utf8")).toBe("cube(1);\n");
      expect(await readFile(join(staged.dir, "root", "model.scad"), "utf8")).toBe("TAMPERED\n");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Operation claims + idempotent replay (Issue #90 AC5/AC6)
// ═════════════════════════════════════════════════════════════════════════════

describe("claims: reserve / lookup / replay", () => {
  it("reserves once; a retry with the SAME digest is recognized, not a fresh reservation", async () => {
    await withCtx(async (ctx) => {
      const first = await reserveClaimLocked(ctx, "op-a", "digest-a", { n: 1 });
      expect(first).toEqual({ kind: "reserved" });
      const second = await reserveClaimLocked(ctx, "op-a", "digest-a", { n: 1 });
      expect(second).toEqual({ kind: "same-request", terminal: null });
    });
  });

  it("a different digest against an already-reserved id is CONFLICT", async () => {
    await withCtx(async (ctx) => {
      await reserveClaimLocked(ctx, "op-b", "digest-b", {});
      const result = await reserveClaimLocked(ctx, "op-b", "digest-different", {});
      expect(result).toEqual({ kind: "conflict" });
    });
  });

  it("decideReplay: same id+digest, terminal -> replay; different digest -> conflict (including against aborted/rejected); unclaimed -> proceed", async () => {
    const committed = {
      version: 1 as const,
      operationId: "op-c",
      requestDigest: "d",
      request: null,
      terminal: { kind: "committed" as const, receipt: { fake: true } as never, transactionId: "tx-1" }
    };
    expect(decideReplay(committed, "d")).toEqual({ kind: "replay", terminal: committed.terminal });
    expect(decideReplay(committed, "different")).toEqual({ kind: "conflict", message: null });
    expect(decideReplay(null, "d")).toEqual({ kind: "proceed" });

    const aborted = { ...committed, terminal: { kind: "aborted" as const } };
    // Same digest against an ABORTED claim is STILL conflict, with the exact spec message -- never replayed as-is.
    expect(decideReplay(aborted, "d")).toEqual({ kind: "conflict", message: ABORTED_REPLAY_MESSAGE });
    expect(decideReplay(aborted, "different")).toEqual({ kind: "conflict", message: null });
  });

  it("recordClaimAbortedLocked never downgrades an already-terminal claim", async () => {
    await withCtx(async (ctx) => {
      await reserveClaimLocked(ctx, "op-d", "digest-d", {});
      const raw = JSON.parse(await readFile(operationPath(projectDir, "op-d"), "utf8"));
      raw.terminal = { kind: "committed", receipt: { fake: true }, transactionId: "tx-x" };
      await writeFile(operationPath(projectDir, "op-d"), JSON.stringify(raw, null, 2), "utf8");

      await recordClaimAbortedLocked(ctx, "op-d");

      const after = await lookupClaimLocked(ctx, "op-d");
      expect(after.kind).toBe("committed"); // NOT downgraded to aborted
    });
  });
});
