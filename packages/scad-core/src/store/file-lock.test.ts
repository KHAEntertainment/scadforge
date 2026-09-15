// SPDX-License-Identifier: Apache-2.0
//
// Stale-lock reclaim (Issue #73 / S3-B ticket B2). See `file-lock.ts`'s
// module header for the exact reclaim rule this exercises.

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_OWNER_FILE, STALE_LOCK_MIN_AGE_MS, withFileLock } from "./file-lock.js";

let workDir: string;
let lockDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "scadcore-file-lock-test-"));
  lockDir = join(workDir, "some.lock");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A pid guaranteed dead on this host: spawn a trivial child and wait for it to exit. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (result.pid === undefined) throw new Error("failed to spawn a throwaway process for a dead-pid fixture");
  return result.pid;
}

async function writeOwner(dir: string, owner: { pid: number; startedAt: string; hostname: string }): Promise<void> {
  await writeFile(join(dir, LOCK_OWNER_FILE), JSON.stringify(owner, null, 2), "utf8");
}

describe("withFileLock stale-owner reclaim (Issue #73)", () => {
  it("a lock held by a live pid is NOT reclaimed -- the contender exhausts the wait budget and fails CONFLICT", async () => {
    await mkdir(lockDir);
    await writeOwner(lockDir, { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() });

    // A short custom maxWaitMs -- this test only cares that a live holder is
    // never reclaimed and the caller eventually fails CONFLICT, not the real
    // production budget (proven separately below), so it need not spend the
    // default FILE_LOCK_MAX_WAIT_MS on every run.
    await expect(withFileLock(lockDir, "test", async () => "should never run", 300)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });

    // The live owner's lock directory (and its owner.json) were never touched.
    const owner = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"));
    expect(owner.pid).toBe(process.pid);
  }, 20000);

  it("a lock whose owner.json names a dead pid IS reclaimed atomically -- the contender proceeds well within the backoff ceiling", async () => {
    await mkdir(lockDir);
    await writeOwner(lockDir, { pid: deadPid(), startedAt: new Date().toISOString(), hostname: hostname() });

    const start = Date.now();
    const result = await withFileLock(lockDir, "test", async () => "acquired");
    expect(result).toBe("acquired");
    // A reclaim happens on the FIRST EEXIST, not after burning through the
    // 50-attempt ceiling -- generously bounded well under what 50 attempts
    // of backoff (up to ~100ms+jitter each) would take.
    expect(Date.now() - start).toBeLessThan(2000);

    // The reclaimed debris (a tombstoned copy of the dead owner's directory)
    // was cleaned up -- only this call's own lock directory lifecycle
    // remains (removed again by withFileLock's own `finally`), so the work
    // dir is left with no `.stale-` leftovers.
    const leftovers = await readdir(workDir);
    expect(leftovers.some((name) => name.includes(".stale-"))).toBe(false);
  }, 20000);

  it("a lock with NO owner.json and a FRESH mtime is NOT reclaimed -- it may simply be mid-acquisition", async () => {
    await mkdir(lockDir); // no owner.json written -- simulates the narrow window before writeOwnerFile runs

    await expect(withFileLock(lockDir, "test", async () => "should never run", 300)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });
  }, 20000);

  it("a lock with NO owner.json and an OLD mtime IS reclaimed -- debris from a holder that died before writing owner.json", async () => {
    await mkdir(lockDir);
    const past = new Date(Date.now() - 2 * STALE_LOCK_MIN_AGE_MS);
    await utimes(lockDir, past, past);

    const result = await withFileLock(lockDir, "test", async () => "acquired");
    expect(result).toBe("acquired");
  }, 20000);

  it("a lock owned by a pid on a DIFFERENT host is never reclaimed, however dead it might be -- no cross-host liveness oracle", async () => {
    await mkdir(lockDir);
    await writeOwner(lockDir, { pid: deadPid(), startedAt: new Date().toISOString(), hostname: `not-${hostname()}` });

    await expect(withFileLock(lockDir, "test", async () => "should never run", 300)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });
  }, 20000);

  it("the winning acquirer writes its own owner.json, readable while the lock is held", async () => {
    let observedOwner: { pid: number; hostname: string } | null = null;
    await withFileLock(lockDir, "test", async () => {
      observedOwner = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"));
    });
    expect(observedOwner).toMatchObject({ pid: process.pid, hostname: hostname() });
  });

  it("releases the lock directory entirely on success -- no owner.json debris survives after fn resolves", async () => {
    await withFileLock(lockDir, "test", async () => "done");
    const exists = await readdir(workDir).then((entries) => entries.includes("some.lock"));
    expect(exists).toBe(false);
  });
});

describe("withFileLock wall-clock wait budget (Issue #115)", () => {
  it("N live, fully-serialized holders whose total real hold time exceeds a fixed attempt-count-equivalent, but stays under maxWaitMs, all succeed", async () => {
    // Old behavior: a FIXED ATTEMPT COUNT gave up after ~50 attempts
    // regardless of how many legitimate holders were queued or how long
    // each one's critical section took -- proven failing pre-fix against
    // the real default budget (see the PR body for that one-off run). This
    // proves the fix's direction on a small, fast, injectable deadline: 6
    // holders x 120ms fully serialize to ~720ms, comfortably under a 2000ms
    // maxWaitMs, so every caller succeeds even though none of them is the
    // first to acquire.
    const N = 6;
    const holdMs = 120;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withFileLock(
          lockDir,
          "test",
          async () => {
            await new Promise((r) => setTimeout(r, holdMs));
            return i;
          },
          2000
        )
      )
    );
    expect(new Set(results).size).toBe(N);
  }, 10000);

  it("a live holder that outlasts maxWaitMs fails the waiter with CONFLICT at about the deadline, not at attempt exhaustion", async () => {
    await mkdir(lockDir);
    await writeOwner(lockDir, { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() });

    const start = Date.now();
    await expect(withFileLock(lockDir, "test", async () => "should never run", 300)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });
    const elapsedMs = Date.now() - start;
    // Gives up close to the 300ms deadline -- nowhere near the default
    // FILE_LOCK_MAX_WAIT_MS (10s), which the old attempt-count mechanism
    // would have forced regardless of this caller's own maxWaitMs.
    expect(elapsedMs).toBeGreaterThanOrEqual(300);
    expect(elapsedMs).toBeLessThan(2000);
  }, 10000);
});
