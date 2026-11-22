// SPDX-License-Identifier: Apache-2.0
//
// Stale-lock reclaim race (Issue #128). A late reclaimer that made its
// "stale" decision against a dead owner's lock must never remove a SUCCESSOR's
// live lock. These tests drive the exact interleavings deterministically by
// gating `node:fs/promises` calls (a `vi.mock` wrapper that delegates to the
// real fs unless a test installs a hook) -- no production code path exists
// for the test's benefit. They live in their own file so the module mock
// cannot leak into `file-lock.test.ts`.
//
// The gate pauses the FIRST contender ("B") at the first MUTATING call it
// makes after deciding the lock is stale: the `rename(lockDir, tombstone)` in
// the original code, or the breaker `mkdir` in the fixed code. Whichever
// version is under test, B is therefore paused between its stale decision
// and any change to the filesystem, while the other contender ("A") runs
// to completion of its acquisition.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_OWNER_FILE, withFileLock } from "./file-lock.js";

type GateOp = "rename-lock" | "mkdir-breaker" | "readdir";

const hooks = vi.hoisted(() => ({
  lockDir: "",
  beforeMutate: null as null | ((op: GateOp, path: string) => Promise<void>),
  beforeOwnerWrite: null as null | ((path: string) => Promise<void>)
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  type Fn = (...args: unknown[]) => Promise<unknown>;
  const isBreaker = (p: unknown) => typeof p === "string" && p.startsWith(`${hooks.lockDir}.breaker-`);
  return {
    ...actual,
    mkdir: async (p: unknown, ...rest: unknown[]) => {
      if (hooks.beforeMutate && isBreaker(p)) await hooks.beforeMutate("mkdir-breaker", p as string);
      return (actual.mkdir as unknown as Fn)(p, ...rest);
    },
    rename: async (from: unknown, to: unknown) => {
      if (hooks.beforeMutate && from === hooks.lockDir) await hooks.beforeMutate("rename-lock", from as string);
      return actual.rename(from as string, to as string);
    },
    readdir: async (p: unknown, ...rest: unknown[]) => {
      if (hooks.beforeMutate && typeof p === "string" && p === join(hooks.lockDir, "..")) {
        await hooks.beforeMutate("readdir", p);
      }
      return (actual.readdir as unknown as Fn)(p, ...rest);
    },
    writeFile: async (p: unknown, ...rest: unknown[]) => {
      if (hooks.beforeOwnerWrite && p === join(hooks.lockDir, LOCK_OWNER_FILE)) await hooks.beforeOwnerWrite(p);
      return (actual.writeFile as unknown as Fn)(p, ...rest);
    }
  };
});

const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let workDir: string;
let lockDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "scadcore-file-lock-race-"));
  lockDir = join(workDir, "some.lock");
  hooks.lockDir = lockDir;
  hooks.beforeMutate = null;
  hooks.beforeOwnerWrite = null;
});

afterEach(async () => {
  hooks.beforeMutate = null;
  hooks.beforeOwnerWrite = null;
  await rm(workDir, { recursive: true, force: true });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A pid guaranteed dead on this host: spawn a trivial child and wait for it to exit. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (result.pid === undefined) throw new Error("failed to spawn a throwaway process for a dead-pid fixture");
  return result.pid;
}

/** A lock left behind by a dead owner on this host: every contender decides "stale". */
async function seedDeadOwnerLock(): Promise<void> {
  await real.mkdir(lockDir);
  await real.writeFile(
    join(lockDir, LOCK_OWNER_FILE),
    JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), hostname: hostname() }),
    "utf8"
  );
}

/** Pauses the first contender to reach a mutating call after its stale decision. */
function pauseFirstMutation(): { reached: Promise<void>; release: () => void } {
  const reached = deferred();
  const release = deferred();
  let taken = false;
  hooks.beforeMutate = async (op) => {
    if (op === "readdir" || taken) return;
    taken = true;
    reached.resolve();
    await release.promise;
  };
  return { reached: reached.promise, release: () => release.resolve() };
}

/** A critical section that records how many holders are inside it at once, and stays inside until `open()` is called. */
function trackedSection() {
  const gate = deferred();
  const entered = deferred();
  let inside = 0;
  let max = 0;
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      inside++;
      max = Math.max(max, inside);
      entered.resolve();
      try {
        await gate.promise;
      } finally {
        inside--;
      }
    },
    entered: entered.promise,
    open: () => gate.resolve(),
    get max() {
      return max;
    },
    get calls() {
      return calls;
    }
  };
}

describe("stale-lock reclaim race (Issue #128)", () => {
  it("the Issue's schedule: a second reclaimer paused after its stale decision never removes the first one's live lock", async () => {
    await seedDeadOwnerLock();
    const paused = pauseFirstMutation();
    const section = trackedSection();

    const first = withFileLock(lockDir, "test", section.fn, 5000);
    const second = withFileLock(lockDir, "test", section.fn, 5000);

    await paused.reached; // B has decided "stale" and is held before touching the filesystem
    await Promise.race([section.entered, sleep(400)]); // A reclaims, acquires and sits inside fn
    paused.release();
    await sleep(300); // give B every chance to act on its (now outdated) decision

    section.open();
    await Promise.all([first, second]);

    expect(section.max).toBe(1);
    expect(section.calls).toBe(2);
    expect(await real.readdir(workDir)).toEqual([]); // no lock, tombstone or breaker debris
  }, 20000);

  it("three simultaneous reclaimers: at most one holder inside fn at any time, and every contender completes once", async () => {
    await seedDeadOwnerLock();
    const paused = pauseFirstMutation();
    const section = trackedSection();

    const all = [1, 2, 3].map(() => withFileLock(lockDir, "test", section.fn, 8000));

    await paused.reached;
    await Promise.race([section.entered, sleep(400)]);
    paused.release();
    await sleep(300);

    section.open();
    await Promise.all(all);

    expect(section.max).toBe(1);
    expect(section.calls).toBe(3);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);

  it("a successor that has done mkdir but not yet written owner.json (ownerless, fresh mtime) is not reclaimed by the paused contender", async () => {
    await seedDeadOwnerLock();
    const paused = pauseFirstMutation();
    const section = trackedSection();

    // The first acquirer to reach the owner write is held right there: its
    // lock directory exists but is still ownerless (and fresh).
    const ownerWriteReached = deferred();
    const ownerWriteRelease = deferred();
    let ownerWriteTaken = false;
    hooks.beforeOwnerWrite = async () => {
      if (ownerWriteTaken) return;
      ownerWriteTaken = true;
      ownerWriteReached.resolve();
      await ownerWriteRelease.promise;
    };

    const first = withFileLock(lockDir, "test", section.fn, 8000);
    const second = withFileLock(lockDir, "test", section.fn, 8000);

    await paused.reached; // B decided "stale" against the dead owner
    await ownerWriteReached.promise; // A reclaimed and mkdir'd; its owner.json is not written yet
    paused.release(); // B now acts on its outdated decision against A's ownerless directory
    await sleep(300);

    ownerWriteRelease.resolve();
    await sleep(300);
    section.open();
    await Promise.all([first, second]);

    expect(section.max).toBe(1);
    expect(section.calls).toBe(2);
  }, 20000);

  it("two reclaimers colliding inside the breaker step never both proceed: both back off, then exactly one reclaims", async () => {
    await seedDeadOwnerLock();
    const section = trackedSection();

    // Hold each contender at its breaker-sibling listing until BOTH have
    // created their own breaker -- the exact collision the listing step must
    // resolve by mutual back-off.
    let arrived = 0;
    let lockRenames = 0;
    const bothArrived = deferred();
    const open = deferred();
    hooks.beforeMutate = async (op) => {
      if (op === "rename-lock") lockRenames++;
      if (op !== "readdir") return;
      arrived++;
      if (arrived === 2) bothArrived.resolve();
      await open.promise;
    };

    const first = withFileLock(lockDir, "test", section.fn, 8000);
    const second = withFileLock(lockDir, "test", section.fn, 8000);

    await bothArrived.promise;
    const breakersAtCollision = (await real.readdir(workDir)).filter((name) => name.includes(".breaker-"));
    expect(breakersAtCollision).toHaveLength(2);
    expect(lockRenames).toBe(0); // neither proceeded past the breaker step while colliding
    open.resolve();

    await sleep(300);
    section.open();
    await Promise.all([first, second]);

    expect(lockRenames).toBe(1); // the dead instance was moved aside once; no live lock was ever moved
    expect(section.max).toBe(1);
    expect(section.calls).toBe(2);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);

  it("a late owner write that finds another record already there loses the acquisition: fn never runs and the successor's record is not clobbered", async () => {
    const successor = { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), token: "successor-token" };
    hooks.beforeOwnerWrite = async () => {
      // Between this acquirer's mkdir and its owner write, a successor's record lands.
      await real.writeFile(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(successor), "utf8");
    };
    const section = trackedSection();

    await expect(withFileLock(lockDir, "test", section.fn, 300)).rejects.toMatchObject({ error_code: "CONFLICT" });

    expect(section.calls).toBe(0);
    expect(JSON.parse(await real.readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"))).toEqual(successor);
  }, 20000);

  it("an owner write that fails for any other reason fails closed: the raw error is rethrown, fn never runs, no lock directory is left", async () => {
    const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    hooks.beforeOwnerWrite = async () => {
      throw enospc;
    };
    const section = trackedSection();

    await expect(withFileLock(lockDir, "test", section.fn, 300)).rejects.toBe(enospc);

    expect(section.calls).toBe(0);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);
});
