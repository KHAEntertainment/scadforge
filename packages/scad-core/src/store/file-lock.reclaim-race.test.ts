// SPDX-License-Identifier: Apache-2.0
//
// Stale-lock reclaim race (Issue #128). A late reclaimer that made its
// "stale" decision against a dead owner's lock must never remove a SUCCESSOR's
// live lock, and a live acquirer that is merely slow to publish its owner
// record must never lose its lock to a reclaimer that decided while it was
// slow. These tests drive the exact interleavings deterministically by gating
// `node:fs/promises` calls (a `vi.mock` wrapper that delegates to the real fs
// unless a test installs a hook) -- no production code path exists for the
// test's benefit. They live in their own file so the module mock cannot leak
// into `file-lock.test.ts`.
//
// Two kinds of waiting, kept apart on purpose:
//   - A REQUIRED event (a contender reached a gate, a holder entered `fn`) is
//     awaited with `within()`, which REJECTS with a named error when its bound
//     expires. A schedule that did not actually run therefore fails the test;
//     it can never pass vacuously. Every release of a paused contender is
//     gated on such an event, never on elapsed time.
//   - A NEGATIVE observation ("nothing bad happens now that B was released")
//     can only be bounded in time. `settle()` is that bounded window and is
//     only ever used AFTER the required events, to let a violation, were there
//     one, surface.

import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_OWNER_FILE, STALE_LOCK_MIN_AGE_MS, withFileLock } from "./file-lock.js";

type GateOp = "rename-lock" | "mkdir-breaker" | "readdir" | "release-rename";

const hooks = vi.hoisted(() => ({
  lockDir: "",
  beforeMutate: null as null | ((op: GateOp, path: string) => Promise<void>),
  /** Fires immediately before the exclusive creation of `owner.json` in the lock directory (the `link` that publishes it, or the exclusive `writeFile` of the pre-adoption code). */
  beforePublish: null as null | ((path: string) => Promise<void>),
  beforeTombstoneRemove: null as null | ((path: string) => Promise<void>)
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  type Fn = (...args: unknown[]) => Promise<unknown>;
  const isBreaker = (p: unknown) => typeof p === "string" && p.startsWith(`${hooks.lockDir}.breaker-`);
  const ownerPath = () => join(hooks.lockDir, LOCK_OWNER_FILE);
  return {
    ...actual,
    mkdir: async (p: unknown, ...rest: unknown[]) => {
      if (hooks.beforeMutate && isBreaker(p)) await hooks.beforeMutate("mkdir-breaker", p as string);
      return (actual.mkdir as unknown as Fn)(p, ...rest);
    },
    rename: async (from: unknown, to: unknown) => {
      if (hooks.beforeMutate && from === hooks.lockDir) {
        await hooks.beforeMutate(String(to).includes(".released-") ? "release-rename" : "rename-lock", from as string);
      }
      return actual.rename(from as string, to as string);
    },
    readdir: async (p: unknown, ...rest: unknown[]) => {
      if (hooks.beforeMutate && typeof p === "string" && p === join(hooks.lockDir, "..")) {
        await hooks.beforeMutate("readdir", p);
      }
      return (actual.readdir as unknown as Fn)(p, ...rest);
    },
    writeFile: async (p: unknown, ...rest: unknown[]) => {
      if (hooks.beforePublish && p === ownerPath()) await hooks.beforePublish(p as string);
      return (actual.writeFile as unknown as Fn)(p, ...rest);
    },
    link: async (existing: unknown, to: unknown) => {
      if (hooks.beforePublish && to === ownerPath()) await hooks.beforePublish(to as string);
      return actual.link(existing as string, to as string);
    },
    rm: async (p: unknown, ...rest: unknown[]) => {
      if (hooks.beforeTombstoneRemove && typeof p === "string" && p.startsWith(`${hooks.lockDir}.released-`)) {
        await hooks.beforeTombstoneRemove(p);
      }
      return (actual.rm as unknown as Fn)(p, ...rest);
    }
  };
});

const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let workDir: string;
let lockDir: string;

beforeEach(async () => {
  workDir = await real.mkdtemp(join(tmpdir(), "scadcore-file-lock-race-"));
  lockDir = join(workDir, "some.lock");
  hooks.lockDir = lockDir;
  hooks.beforeMutate = null;
  hooks.beforePublish = null;
  hooks.beforeTombstoneRemove = null;
});

afterEach(async () => {
  hooks.beforeMutate = null;
  hooks.beforePublish = null;
  hooks.beforeTombstoneRemove = null;
  await real.rm(workDir, { recursive: true, force: true });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Awaits a REQUIRED event; rejects with a named error if it does not happen within `ms`, so a schedule that did not run fails the test instead of passing vacuously. */
function within<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`schedule did not run: timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The bounded window for a NEGATIVE observation, used only after the required events (see the header). */
const settle = (ms = 300) => new Promise<void>((r) => setTimeout(r, ms));

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

/** Backdates the lock directory past `STALE_LOCK_MIN_AGE_MS`, as if its creator had been paused that long. */
async function backdateLockDir(): Promise<void> {
  const past = new Date(Date.now() - 2 * STALE_LOCK_MIN_AGE_MS);
  await real.utimes(lockDir, past, past);
}

/** Pauses the first contender to reach a mutating call after its stale decision (a breaker `mkdir` or a rename of the lock). */
function pauseFirstMutation(): { reached: Promise<void>; release: () => void } {
  const reached = deferred();
  const release = deferred();
  let taken = false;
  hooks.beforeMutate = async (op) => {
    if ((op !== "rename-lock" && op !== "mkdir-breaker") || taken) return;
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

    const first = withFileLock(lockDir, "test", section.fn, 8000);
    const second = withFileLock(lockDir, "test", section.fn, 8000);

    await within(paused.reached, "a contender to be held after its stale decision");
    await within(section.entered, "the other contender to reclaim, acquire and be inside fn");
    paused.release(); // B now acts on its (outdated) decision
    await settle();

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

    await within(paused.reached, "a contender to be held after its stale decision");
    await within(section.entered, "another contender to reclaim, acquire and be inside fn");
    paused.release();
    await settle();

    section.open();
    await Promise.all(all);

    expect(section.max).toBe(1);
    expect(section.calls).toBe(3);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);

  it("a successor that has done mkdir but not yet published its owner record (ownerless, fresh mtime) is not reclaimed by the paused contender", async () => {
    await seedDeadOwnerLock();
    const paused = pauseFirstMutation();
    const section = trackedSection();

    // The first acquirer to reach publication is held right there: its lock
    // directory exists but is still ownerless (and fresh).
    const publishReached = deferred();
    const publishRelease = deferred();
    let publishTaken = false;
    hooks.beforePublish = async () => {
      if (publishTaken) return;
      publishTaken = true;
      publishReached.resolve();
      await publishRelease.promise;
    };

    const first = withFileLock(lockDir, "test", section.fn, 8000);
    const second = withFileLock(lockDir, "test", section.fn, 8000);

    await within(paused.reached, "a contender to be held after its stale decision");
    await within(publishReached.promise, "the other contender to reclaim and mkdir, held before publishing");
    paused.release(); // B now acts on its outdated decision against an ownerless directory
    await settle();

    publishRelease.resolve();
    await within(section.entered, "the publishing contender to enter fn");
    await settle();
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

    await within(bothArrived.promise, "both contenders to reach the breaker listing");
    const breakersAtCollision = (await real.readdir(workDir)).filter((name) => name.includes(".breaker-"));
    expect(breakersAtCollision).toHaveLength(2);
    expect(lockRenames).toBe(0); // neither proceeded past the breaker step while colliding
    open.resolve();

    await within(section.entered, "one contender to reclaim after the mutual back-off");
    await settle();
    section.open();
    await Promise.all([first, second]);

    expect(lockRenames).toBe(1); // the dead instance was moved aside once; no live lock was ever moved
    expect(section.max).toBe(1);
    expect(section.calls).toBe(2);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);

  it("a late publication that finds another record already there loses the acquisition: fn never runs and the successor's record is not clobbered", async () => {
    const successor = { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), token: "successor-token" };
    hooks.beforePublish = async () => {
      // Between this acquirer's mkdir and its publication, a successor's record lands.
      await real.writeFile(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(successor), "utf8");
    };
    const section = trackedSection();

    await expect(withFileLock(lockDir, "test", section.fn, 300)).rejects.toMatchObject({ error_code: "CONFLICT" });

    expect(section.calls).toBe(0);
    expect(JSON.parse(await real.readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"))).toEqual(successor);
    expect((await real.readdir(lockDir)).filter((name) => name.startsWith(`${LOCK_OWNER_FILE}.tmp-`))).toEqual([]); // the loser's temp file is cleaned up
  }, 20000);

  it("a publication that fails for any other reason fails closed: the raw error is rethrown, fn never runs, no lock directory is left", async () => {
    const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    hooks.beforePublish = async () => {
      throw enospc;
    };
    const section = trackedSection();

    await expect(withFileLock(lockDir, "test", section.fn, 300)).rejects.toBe(enospc);

    expect(section.calls).toBe(0);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);
});

describe("live acquirer slow to publish vs. reclaimer (Issue #128 review F1)", () => {
  it("the reviewer's schedule: X mkdirs and stalls 60 s+ before publishing, R decides 'ownerless and old' and stalls before acting, X publishes and enters fn, R resumes -- R must not remove X's now-live lock", async () => {
    const section = trackedSection();
    const releaseX = deferred();
    const releaseR = deferred();
    const xAtPublish = deferred();
    const rAtAction = deferred();
    let publishCalls = 0;
    let rParked = false;
    // X's publication is call #1. R's first action after its decision is the
    // rename of the "stale" directory (the pre-adoption code) or its own
    // publication into it, call #2 (the fixed code): either way R is parked
    // between deciding and acting.
    hooks.beforePublish = async () => {
      publishCalls++;
      if (publishCalls === 1) {
        xAtPublish.resolve();
        await releaseX.promise;
      } else if (publishCalls === 2 && !rParked) {
        rParked = true;
        rAtAction.resolve();
        await releaseR.promise;
      }
    };
    hooks.beforeMutate = async (op) => {
      if (op !== "rename-lock" || rParked) return;
      rParked = true;
      rAtAction.resolve();
      await releaseR.promise;
    };

    const x = withFileLock(lockDir, "test", section.fn, 8000);
    await within(xAtPublish.promise, "X to have created the directory and be held before publishing");
    await backdateLockDir(); // X has now been stalled for 60 s+

    const r = withFileLock(lockDir, "test", section.fn, 8000);
    await within(rAtAction.promise, "R to decide the directory is reclaimable and be held before acting on it");

    releaseX.resolve(); // X publishes and enters fn
    await within(section.entered, "X to publish and enter fn");

    releaseR.resolve(); // R now acts on its (outdated) decision
    await settle();

    section.open();
    await Promise.all([x, r]);

    expect(section.max).toBe(1);
    expect(section.calls).toBe(2);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);

  it("two adopters and the stalled original acquirer racing to publish into one ownerless-old directory: exactly one publishes, fn never overlaps, every contender completes once", async () => {
    const section = trackedSection();
    const release = deferred();
    const xAtPublish = deferred();
    const adoptersAtPublish = deferred();
    let publishCalls = 0;
    hooks.beforePublish = async () => {
      publishCalls++;
      if (publishCalls === 1) xAtPublish.resolve();
      if (publishCalls === 3) adoptersAtPublish.resolve();
      if (publishCalls <= 3) await release.promise; // the first three publications are released together
    };

    const x = withFileLock(lockDir, "test", section.fn, 8000);
    await within(xAtPublish.promise, "X to be held before publishing");
    await backdateLockDir();

    const adopters = [withFileLock(lockDir, "test", section.fn, 8000), withFileLock(lockDir, "test", section.fn, 8000)];
    await within(adoptersAtPublish.promise, "both adopters to reach their publication");
    release.resolve(); // X, A1 and A2 all race to publish into the same instance

    await within(section.entered, "the single publisher to enter fn");
    await settle();
    expect(section.calls).toBe(1); // the other two lost the publication and are waiting, not inside fn
    const record = JSON.parse(await real.readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"));
    expect(typeof record.token).toBe("string");

    section.open();
    await Promise.all([x, ...adopters]);

    expect(section.max).toBe(1);
    expect(section.calls).toBe(3);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);

  it("a publication stalled between its temp write and its link: a concurrent reader sees no record (ownerless), never a torn one, and the temp file is never mistaken for one", async () => {
    const section = trackedSection();
    const reached = deferred();
    const release = deferred();
    let taken = false;
    hooks.beforePublish = async () => {
      if (taken) return;
      taken = true;
      reached.resolve();
      await release.promise;
    };

    const holder = withFileLock(lockDir, "test", section.fn, 8000);
    await within(reached.promise, "the publisher to be held between its temp write and its link");

    const names = await real.readdir(lockDir);
    expect(names).not.toContain(LOCK_OWNER_FILE);
    expect(names.some((name) => name.startsWith(`${LOCK_OWNER_FILE}.tmp-`))).toBe(true);
    await expect(real.readFile(join(lockDir, LOCK_OWNER_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // A concurrent contender reads the same state: ownerless and fresh, so it holds off.
    await expect(withFileLock(lockDir, "test", async () => "should never run", 200)).rejects.toMatchObject({ error_code: "CONFLICT" });

    release.resolve();
    await within(section.entered, "the publisher to enter fn");
    const record = JSON.parse(await real.readFile(join(lockDir, LOCK_OWNER_FILE), "utf8")); // whole, parseable
    expect(record).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect((await real.readdir(lockDir)).filter((name) => name.startsWith(`${LOCK_OWNER_FILE}.tmp-`))).toEqual([]);

    section.open();
    await holder;
  }, 20000);

  it("release is atomic: while the released lock's tombstone is still being removed, the intact record is inside it and a contender has already acquired the lock path", async () => {
    const first = trackedSection();
    const second = trackedSection();
    const removalReached = deferred();
    const removalRelease = deferred();
    let removalTaken = false;
    hooks.beforeTombstoneRemove = async () => {
      if (removalTaken) return;
      removalTaken = true;
      removalReached.resolve();
      await removalRelease.promise;
    };

    const holder = withFileLock(lockDir, "test", first.fn, 8000);
    await within(first.entered, "the first holder to enter fn");
    const contender = withFileLock(lockDir, "test", second.fn, 8000);

    first.open(); // the first holder finishes and releases
    await within(removalReached.promise, "the release to be held at the removal of its tombstone");
    await within(second.entered, "the contender to mkdir, publish and enter fn while the tombstone removal is still pending");

    const tombstone = (await real.readdir(workDir)).find((name) => name.includes(".released-"));
    expect(tombstone).toBeDefined();
    // The record was never unlinked before the path left the namespace.
    const record = JSON.parse(await real.readFile(join(workDir, tombstone as string, LOCK_OWNER_FILE), "utf8"));
    expect(record).toMatchObject({ pid: process.pid, hostname: hostname() });

    removalRelease.resolve();
    second.open();
    await Promise.all([holder, contender]);

    expect(first.max).toBe(1);
    expect(second.max).toBe(1);
    expect(await real.readdir(workDir)).toEqual([]);
  }, 20000);
});
