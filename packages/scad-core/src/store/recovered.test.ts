// SPDX-License-Identifier: Apache-2.0
//
// `withRecoveredProject` (Issue #73 / S3-B ticket B2): the runtime
// non-reentrancy guard, and basic ctx plumbing. See `recovered.types.test.ts`
// for the companion compile-time guarantee (LockedProject is opaque).

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectManifest } from "@scadforge/protocol";
import { withRecoveredProject } from "./recovered.js";
import { metaDir, projectFilePath } from "./paths.js";
import { LOCK_OWNER_FILE } from "./file-lock.js";
import { EMPTY_SIDECAR, readSidecarLocked, sidecarPath, writeSidecarLocked } from "../editor/sidecar.js";

let projectDirA: string;
let projectDirB: string;

beforeEach(async () => {
  projectDirA = await mkdtemp(join(tmpdir(), "scadcore-recovered-test-a-"));
  projectDirB = await mkdtemp(join(tmpdir(), "scadcore-recovered-test-b-"));
  // withRecoveredProject's lock is a non-recursive mkdir under `.scadforge/`
  // (file-lock.ts) -- these tests exercise the boundary itself, not
  // initProject's own "meta dir doesn't exist yet" special case (that is
  // covered by store.test.ts), so pre-create it exactly like an already
  // -initialized project would have.
  await mkdir(metaDir(projectDirA), { recursive: true });
  await mkdir(metaDir(projectDirB), { recursive: true });
});

afterEach(async () => {
  await rm(projectDirA, { recursive: true, force: true });
  await rm(projectDirB, { recursive: true, force: true });
});

describe("withRecoveredProject", () => {
  it("a projectDir with no .scadforge/ (not an initialized project) fails PROJECT_NOT_FOUND, not a generic INTERNAL_ERROR", async () => {
    const uninitialized = await mkdtemp(join(tmpdir(), "scadcore-recovered-test-uninit-"));
    try {
      await expect(withRecoveredProject(uninitialized, async () => "should never run")).rejects.toMatchObject({
        error_code: "PROJECT_NOT_FOUND"
      });
    } finally {
      await rm(uninitialized, { recursive: true, force: true });
    }
  });

  it("hands fn a ctx whose projectDir matches the input", async () => {
    const seen = await withRecoveredProject(projectDirA, async (ctx) => ctx.projectDir);
    expect(seen).toBe(projectDirA);
  });

  it("returns fn's resolved value", async () => {
    const result = await withRecoveredProject(projectDirA, async () => 42);
    expect(result).toBe(42);
  });

  it("propagates fn's rejection", async () => {
    await expect(
      withRecoveredProject(projectDirA, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });

  it("releases the lock after fn resolves -- a second, sequential call succeeds", async () => {
    await withRecoveredProject(projectDirA, async () => "first");
    const second = await withRecoveredProject(projectDirA, async () => "second");
    expect(second).toBe("second");
  });

  it("releases the lock after fn rejects -- a subsequent call is not wedged", async () => {
    await withRecoveredProject(projectDirA, async () => {
      throw new Error("boom");
    }).catch(() => {});
    const after = await withRecoveredProject(projectDirA, async () => "recovered");
    expect(after).toBe("recovered");
  });

  it("nesting withRecoveredProject for the SAME projectDir on the same async chain throws INTERNAL_ERROR immediately, never after the 50-attempt backoff ceiling", async () => {
    const start = Date.now();
    await expect(
      withRecoveredProject(projectDirA, async () =>
        withRecoveredProject(projectDirA, async () => "should never run")
      )
    ).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });
    // Immediate, not the ~50 * up-to-110ms backoff loop a real mkdir EEXIST
    // contention would take (multiple seconds -- see file-lock.test.ts).
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("nesting withRecoveredProject for a DIFFERENT projectDir on the same async chain is ALSO refused -- no nested params-lock acquisition, full stop", async () => {
    await expect(
      withRecoveredProject(projectDirA, async () =>
        withRecoveredProject(projectDirB, async () => "should never run")
      )
    ).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });
  });

  it("the reentrancy error names both the already-locked directory and the newly attempted one", async () => {
    await expect(
      withRecoveredProject(projectDirA, async () => withRecoveredProject(projectDirB, async () => "x"))
    ).rejects.toThrow(new RegExp(`${projectDirA}.*${projectDirB}|${projectDirB}.*${projectDirA}`, "s"));
  });

  it("two SEPARATE, non-nested calls for different projects run concurrently without tripping the reentrancy guard", async () => {
    const [a, b] = await Promise.all([
      withRecoveredProject(projectDirA, async () => "a-done"),
      withRecoveredProject(projectDirB, async () => "b-done")
    ]);
    expect(a).toBe("a-done");
    expect(b).toBe("b-done");
  });

  it("two SEPARATE, non-nested concurrent calls for the SAME project both eventually succeed -- serialized by the real file lock, not refused by the reentrancy guard", async () => {
    const order: string[] = [];
    const [a, b] = await Promise.all([
      withRecoveredProject(projectDirA, async () => {
        order.push("a");
        return "a-done";
      }),
      withRecoveredProject(projectDirA, async () => {
        order.push("b");
        return "b-done";
      })
    ]);
    expect(a).toBe("a-done");
    expect(b).toBe("b-done");
    expect(order.sort()).toEqual(["a", "b"]);
  });
});

// ── B2 recovery boundary never touches a corrupt root sidecar (Issue #87 / S3-B ticket B3) ──
//
// Proves the coverage gap named at QA: the recovery boundary -- lock
// acquisition INCLUDING STALE-LOCK RECLAIM (not merely a fresh, uncontended
// lock), the (stub) `recover()` hook, and release -- never moves, rewrites or
// quarantines a corrupt root sidecar. `sidecar.test.ts` already proves
// `readSidecarLocked` classifies corrupt bytes correctly and leaves them
// untouched given an already-open `ctx`; this proves the same property holds
// when that `ctx` is obtained through the real reclaim path B2 added, not a
// hand-waved "the ctx just works" assumption.

/** A pid guaranteed dead on this host: spawn a trivial child and wait for it to exit. Mirrors `file-lock.test.ts`'s own helper (duplicated rather than imported -- that file's helper is not exported, and this test lives in a different describe/file scope). */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (result.pid === undefined) throw new Error("failed to spawn a throwaway process for a dead-pid fixture");
  return result.pid;
}

async function writeOwner(dir: string, owner: { pid: number; startedAt: string; hostname: string }): Promise<void> {
  await writeFile(join(dir, LOCK_OWNER_FILE), JSON.stringify(owner, null, 2), "utf8");
}

/** `withParamsLock`'s own (unexported) lock directory -- see `params-lock.ts`. */
function paramsLockDirFor(projectDir: string): string {
  return join(metaDir(projectDir), "params.lock");
}

const recoveredTestProviderConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

/** A minimal, already-modern (`editor_store_version: 1`) `project.json` -- built by hand rather than via `initProject` (store.ts) so this file stays decoupled from it, matching `sidecar.test.ts`'s own convention. */
async function seedModernProjectManifest(projectDir: string): Promise<void> {
  await mkdir(metaDir(projectDir), { recursive: true });
  const manifest: ProjectManifest = {
    schema_version: 1,
    id: "proj-1",
    name: "Test",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    openscad_image: "openscad/openscad@sha256:test",
    openscad_version: "2026.01.19",
    provider: recoveredTestProviderConfig,
    head: null,
    editor_store_version: 1
  };
  await writeFile(projectFilePath(projectDir), JSON.stringify(manifest, null, 2), "utf8");
}

describe("B2 recovery boundary never touches a corrupt root sidecar, even through stale-lock reclaim (Issue #87 / S3-B ticket B3)", () => {
  it("readSidecarLocked reached through a RECLAIMED stale lock reports corrupt and leaves everything untouched", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "scadcore-recovered-corrupt-sidecar-"));
    try {
      await seedModernProjectManifest(projectDir);
      const corruptBytes = '{"version":1,"features":[';
      await writeFile(sidecarPath(projectDir), corruptBytes, "utf8");
      const projectJsonBefore = await readFile(projectFilePath(projectDir), "utf8");

      // Seed a STALE params lock exactly like a crashed holder would leave
      // one -- a dead pid's owner.json -- so this withRecoveredProject entry
      // actually exercises the reclaim path (file-lock.ts's
      // isReclaimableStaleLock/reclaimStaleLock) and the (stub) recover()
      // hook, not merely a fresh, uncontended mkdir.
      const lockDir = paramsLockDirFor(projectDir);
      await mkdir(lockDir);
      await writeOwner(lockDir, { pid: deadPid(), startedAt: new Date().toISOString(), hostname: hostname() });

      const start = Date.now();
      const result = await withRecoveredProject(projectDir, (ctx) => readSidecarLocked(ctx));
      // Reclaimed on the first EEXIST, not after burning through the
      // 50-attempt backoff ceiling (file-lock.test.ts's own bound).
      expect(Date.now() - start).toBeLessThan(2000);

      expect(result.status).toBe("corrupt");
      expect(result.sidecar).toBeNull();
      expect(result.digest).toBeNull();
      expect(result.error).not.toBeNull();

      // The corrupt bytes are byte-identical -- neither the reclaim, the
      // (stub) recover() hook, nor the read itself moved or rewrote them.
      expect(await readFile(sidecarPath(projectDir), "utf8")).toBe(corruptBytes);
      // Never silently quarantined -- that only ever happens via an
      // EXPLICIT quarantine() call, never as a side effect of a read.
      await expect(stat(join(metaDir(projectDir), "quarantine"))).rejects.toThrow();
      // project.json (the editor_store_version marker) is untouched too.
      expect(await readFile(projectFilePath(projectDir), "utf8")).toBe(projectJsonBefore);

      // The lock was genuinely reclaimed and then properly released -- a
      // second, sequential call succeeds promptly, not wedged.
      const secondStart = Date.now();
      const second = await withRecoveredProject(projectDir, (ctx) => readSidecarLocked(ctx));
      expect(Date.now() - secondStart).toBeLessThan(2000);
      expect(second.status).toBe("corrupt");

      // writeSidecarLocked (Tech Lead correction C2) also refuses over the
      // still-corrupt root -- the bytes remain exactly what they were.
      await expect(
        withRecoveredProject(projectDir, (ctx) => writeSidecarLocked(ctx, EMPTY_SIDECAR))
      ).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });
      expect(await readFile(sidecarPath(projectDir), "utf8")).toBe(corruptBytes);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 20000);
});
