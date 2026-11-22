// SPDX-License-Identifier: Apache-2.0
//
// Stale-lock reclaim (Issue #73 / S3-B ticket B2). See `file-lock.ts`'s
// module header for the exact reclaim rule this exercises.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_LOCK_MAX_WAIT_MS, LOCK_OWNER_FILE, STALE_LOCK_MIN_AGE_MS, withFileLock } from "./file-lock.js";

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

async function writeOwner(dir: string, owner: { pid: number; startedAt: string; hostname: string; token?: string }): Promise<void> {
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
    expect(leftovers.some((name) => name.includes(".stale-") || name.includes(".breaker-") || name.includes(".released-"))).toBe(false);
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

describe("withFileLock maxWaitMs clamping (Issue #115)", () => {
  async function expectFallsBackToDefault(maxWaitMs: number): Promise<void> {
    await mkdir(lockDir);
    await writeOwner(lockDir, { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() });

    // `withFileLock` measures elapsed time with `performance.now()`
    // (monotonic, Issue #115) rather than `Date.now()` -- vitest's fake
    // timers must be told to fake it explicitly, it is not in the default
    // `toFake` list.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    try {
      const pending = withFileLock(lockDir, "test", async () => "should never run", maxWaitMs);
      pending.catch(() => {}); // avoid an unhandled-rejection warning while it's still pending below

      // Just short of the default deadline: must NOT have settled yet -- a
      // non-finite maxWaitMs must fall back to FILE_LOCK_MAX_WAIT_MS, never
      // to "wait forever" (Infinity) or "never wait" (NaN falling through to
      // the 200-attempt count cap instead).
      await vi.advanceTimersByTimeAsync(FILE_LOCK_MAX_WAIT_MS - 500);
      let settled = false;
      pending.then(
        () => (settled = true),
        () => (settled = true)
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).rejects.toMatchObject({ error_code: "CONFLICT" });
    } finally {
      vi.useRealTimers();
    }
  }

  it("NaN maxWaitMs falls back to the production default, not the 200-attempt count cap", async () => {
    await expectFallsBackToDefault(NaN);
  });

  it("Infinity maxWaitMs falls back to the production default, not an unbounded wait", async () => {
    await expectFallsBackToDefault(Infinity);
  });

  it("maxWaitMs=0 gives up after exactly one failed attempt, near-instantly -- passes through unchanged", async () => {
    await mkdir(lockDir); // no owner.json -- fresh, non-reclaimable, same as the "mid-acquisition" fixture above

    const start = Date.now();
    await expect(withFileLock(lockDir, "test", async () => "should never run", 0)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("a negative maxWaitMs behaves the same as 0 -- one attempt, then CONFLICT, passes through unchanged", async () => {
    await mkdir(lockDir);

    const start = Date.now();
    await expect(withFileLock(lockDir, "test", async () => "should never run", -50)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// Breaker names embed the host and pid of their creator (Issue #128); these
// fixtures hand-write that documented shape: `<lockDir>.breaker-<hostTag>-<pid>-<uuid>`.
function breakerPath(pid: number, host: string = hostname()): string {
  const tag = createHash("sha1").update(host).digest("hex").slice(0, 16);
  return `${lockDir}.breaker-${tag}-${pid}-${randomUUID()}`;
}

async function seedDeadOwnerLock(): Promise<void> {
  await mkdir(lockDir);
  await writeOwner(lockDir, { pid: deadPid(), startedAt: new Date().toISOString(), hostname: hostname() });
}

describe("withFileLock reclaim breaker recovery (Issue #128)", () => {
  it("a breaker left by a reclaimer that died (dead pid, this host) is removed and does not wedge the reclaim", async () => {
    await seedDeadOwnerLock();
    const deadBreaker = breakerPath(deadPid());
    await mkdir(deadBreaker);

    const start = Date.now();
    await expect(withFileLock(lockDir, "test", async () => "acquired")).resolves.toBe("acquired");
    expect(Date.now() - start).toBeLessThan(2000);

    expect(await readdir(workDir)).toEqual([]); // no lock, dead breaker, tombstone or own-breaker debris
  }, 20000);

  it.each([
    ["a live pid (this process)", () => breakerPath(process.pid)],
    ["another host", () => breakerPath(deadPid(), `not-${hostname()}`)],
    ["an unparseable name", () => `${lockDir}.breaker-garbage`]
  ])("a breaker naming %s is never removed -- the contender backs off and ends in CONFLICT at its short deadline", async (_label, makePath) => {
    await seedDeadOwnerLock();
    const foreignBreaker = makePath();
    await mkdir(foreignBreaker);

    await expect(withFileLock(lockDir, "test", async () => "should never run", 300)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });

    const leftovers = await readdir(workDir);
    expect(leftovers).toContain(foreignBreaker.slice(workDir.length + 1)); // untouched
    expect(leftovers).toContain("some.lock"); // the stale lock was not reclaimed behind a contended breaker
    expect(leftovers.filter((name) => name.includes(".breaker-"))).toHaveLength(1); // the contender removed its own
  }, 20000);
});

describe("withFileLock owner token and guarded release (Issue #128)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("each acquisition records its own unique token in owner.json, readable while held", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      await withFileLock(lockDir, "test", async () => {
        const owner = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"));
        expect(owner).toMatchObject({ pid: process.pid, hostname: hostname() });
        tokens.push(owner.token);
      });
    }
    expect(tokens.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    expect(new Set(tokens).size).toBe(2);
  });

  const takeovers: Array<[string, () => Promise<void>]> = [
    ["another acquirer's token", () => writeOwner(lockDir, { pid: process.pid, startedAt: "x", hostname: hostname(), token: "someone-else" })],
    ["an old-shape record without a token", () => writeOwner(lockDir, { pid: process.pid, startedAt: "x", hostname: hostname() })],
    ["a torn, unparseable record", () => writeFile(join(lockDir, LOCK_OWNER_FILE), '{"pid": 12', "utf8")],
    ["no owner record at all", () => rm(join(lockDir, LOCK_OWNER_FILE), { force: true })]
  ];

  it.each(takeovers)("release leaves the lock in place and logs loudly when owner.json holds %s; fn's result is still returned", async (_label, tamper) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await withFileLock(lockDir, "test", async () => {
      await tamper();
      return "fn-result";
    });

    expect(result).toBe("fn-result"); // never throws after fn completed
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("LOCK OWNERSHIP VIOLATION"));
    expect((await readdir(workDir)).includes("some.lock")).toBe(true); // never removed on mismatch
  });

  it("a release mismatch does not mask fn's own error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("fn failed");

    await expect(
      withFileLock(lockDir, "test", async () => {
        await writeOwner(lockDir, { pid: process.pid, startedAt: "x", hostname: hostname(), token: "someone-else" });
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  it("a matching token releases normally and silently", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await withFileLock(lockDir, "test", async () => "done");
    expect(logged).not.toHaveBeenCalled();
    expect(await readdir(workDir)).toEqual([]);
  });
});

describe("withFileLock ownerless adoption and unreadable records (Issue #128 review F1)", () => {
  async function backdate(path: string): Promise<void> {
    const past = new Date(Date.now() - 2 * STALE_LOCK_MIN_AGE_MS);
    await utimes(path, past, past);
  }

  it("an ownerless-old directory is ADOPTED, not renamed: the contender publishes its own record into the same directory, with no tombstone or breaker", async () => {
    await mkdir(lockDir);
    await backdate(lockDir);

    let entriesWhileHeld: string[] = [];
    let owner: { pid: number; token?: string } | null = null;
    await withFileLock(lockDir, "test", async () => {
      entriesWhileHeld = await readdir(workDir);
      owner = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"));
    });

    expect(entriesWhileHeld).toEqual(["some.lock"]); // nothing was renamed aside, no breaker was taken
    expect(owner).toMatchObject({ pid: process.pid });
    expect(typeof (owner as unknown as { token: string }).token).toBe("string");
    expect(await readdir(workDir)).toEqual([]);
  });

  it("a leftover publication temp file is never a record: a directory holding only one is still ownerless, and adopted once old", async () => {
    await mkdir(lockDir);
    // Looks like a live owner's record, but it is only a temp file -- if it were
    // read as a record the lock would be held by a live pid and never adopted.
    await writeFile(
      join(lockDir, `${LOCK_OWNER_FILE}.tmp-leftover`),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), token: "leftover" }),
      "utf8"
    );
    await backdate(lockDir);

    await expect(withFileLock(lockDir, "test", async () => "acquired")).resolves.toBe("acquired");
    expect(await readdir(workDir)).toEqual([]);
  });

  it("an owner.json that exists but is unreadable AND whose directory is old IS reclaimed by rename (legacy/corruption path)", async () => {
    await mkdir(lockDir);
    await writeFile(join(lockDir, LOCK_OWNER_FILE), '{"pid": 12', "utf8"); // torn
    await backdate(lockDir);

    await expect(withFileLock(lockDir, "test", async () => "acquired")).resolves.toBe("acquired");
    expect(await readdir(workDir)).toEqual([]);
  });

  it("an owner.json that exists but is unreadable with a FRESH directory is NOT reclaimed -- a writer may be mid-write", async () => {
    await mkdir(lockDir);
    await writeFile(join(lockDir, LOCK_OWNER_FILE), '{"pid": 12', "utf8");

    await expect(withFileLock(lockDir, "test", async () => "should never run", 300)).rejects.toMatchObject({
      error_code: "CONFLICT"
    });
    expect(await readdir(workDir)).toEqual(["some.lock"]);
  }, 20000);
});
