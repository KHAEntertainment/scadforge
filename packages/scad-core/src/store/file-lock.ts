// @scadforge/scad-core — generic cross-process file lock (Issue #48), with
// stale-owner reclaim (Issue #73 / S3-B ticket B2).
//
// The SAME primitive the M1 snapshot store validated for cross-process
// safety (`store.ts`'s CONCURRENCY POLICY / `claimNextSnapshotId`) and
// `params-lock.ts` (Issue #44) uses for `params.json`: a non-recursive
// `mkdir` is atomic at the filesystem/OS level, so exactly one caller --
// in-process or cross-process, same machine (required: the GUI server and,
// from M4, the stdio MCP server share one `.scadforge/` tree) -- ever wins
// the `mkdir` for a given path; every other concurrent caller gets `EEXIST`
// and must retry.
//
// This module is that mechanism lifted one level: `withFileLock` runs `fn`
// while holding the mutex at an arbitrary lock-directory path. The exports
// ledger (Issue #48) uses it so concurrent `recordExport` callers can never
// lose an append; `params-lock.ts` delegates to it so every lock in the
// store shares one retry/backoff/CONFLICT policy instead of drifting
// per-resource copies.
//
// ── STALE-OWNER RECLAIM (Issue #73) ─────────────────────────────────────
//
// Before this fix, a process that died while holding a lock (a hard kill,
// an OOM) wedged every future writer of that resource forever: the lock
// directory never gets removed by a `finally` that never runs, and the
// retry loop below has no way to tell "a live process still holds this"
// from "the holder is gone" -- it can only keep retrying until
// `FILE_LOCK_MAX_WAIT_MS` elapses and fail `CONFLICT`, which then repeats
// for every subsequent caller too. The recovery boundary (`recovered.ts`)
// can never run if the params lock it depends on can be wedged this way.
//
// The lock directory now carries an `owner.json` (`{pid, startedAt,
// hostname}`), written best-effort right after the winning `mkdir`. A
// contender that sees `EEXIST` may reclaim the lock ONLY when the owner is
// PROVABLY gone:
//   - `owner.json` names a pid on THIS host, and that pid is not alive
//     (`process.kill(pid, 0)` throws `ESRCH`) -- the owner crashed after
//     acquiring the lock.
//   - `owner.json` is absent (the holder died between its own `mkdir` and
//     the `owner.json` write) AND the directory's mtime is older than
//     `STALE_LOCK_MIN_AGE_MS` -- a live holder keeps writing under the
//     directory, so a fresh, ownerless directory is presumed to be a
//     holder that has not finished writing `owner.json` yet, not debris.
// A lock whose owner is on ANOTHER host is never reclaimed -- there is no
// cross-host liveness oracle here, and guessing wrong would let two
// processes on different machines both believe they hold the same lock.
// Reclaim is atomic: the stale directory is renamed aside (so at most one
// contender can win that rename) and only then does the winner `mkdir` the
// real name fresh and write its own `owner.json`; the renamed-aside
// directory (holding nothing but a stale `owner.json`) is then removed
// best-effort.
//
// KNOWN LIMITATION -- pid reuse: if the OS recycles a dead owner's pid to
// an unrelated LIVE process before this code observes the death, that pid
// reads back as "alive" and the lock is correctly NOT reclaimed (the
// alternative -- reclaiming a lock some live process actually holds --
// would corrupt that process's read-merge-write, which is strictly worse
// than a temporarily stuck lock). This can leave a lock unreclaimable until
// the unrelated process that inherited the pid also exits. There is
// deliberately no age-based override for a live pid: staleness is decided
// by liveness, never by how long a live owner has held the lock.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { ScadForgeError } from "../errors.js";

/**
 * Wall-clock deadline (ms) to keep retrying acquisition before failing with
 * `CONFLICT` -- the real governing budget (Issue #115). A fixed ATTEMPT
 * COUNT is a poor proxy for this: it says nothing about how many writers are
 * legitimately queued ahead of this caller, or how long each one's held
 * critical section actually takes under host CPU/disk contention. Since
 * Issue #73, every writer of a given project fully serializes on ONE params
 * lock, so N legitimate concurrent callers become N fully-serialized holders
 * -- a count-based budget that ignores N (and load) fails a live, legitimate
 * waiter exactly the same way it would fail against a truly stuck lock.
 * 10s comfortably absorbs the fsync-heavy holders S3-B ticket B4 introduced
 * (measured: 12 fully-serialized `createSnapshot` calls) under contention,
 * while staying safely under the 15s driver-process timeout that B8's
 * `fault-matrix.test.ts` (not owned here) depends on for its live-holder
 * case. Callers needing a different real-time budget (mainly tests) may
 * override it via {@link withFileLock}'s `maxWaitMs` parameter.
 */
export const FILE_LOCK_MAX_WAIT_MS = 10_000;

/**
 * Hard ceiling on retry attempts -- a safety net against a runaway loop, NOT
 * the governing budget: under the backoff curve below, `FILE_LOCK_MAX_WAIT_MS`
 * is always reached well before this count is (Issue #115), so this never
 * binds in practice. Kept generous (mirrors `SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS`'s
 * shape) purely so a future backoff regression fails loudly on this cap
 * rather than spinning forever.
 */
export const FILE_LOCK_MAX_ATTEMPTS = 200;

/** File name of the lock owner record inside a held lock directory. */
export const LOCK_OWNER_FILE = "owner.json";

/** Minimum age (ms) of an ownerless lock directory before it is presumed to be debris from a holder that died before writing `owner.json`, rather than a live holder still in the middle of acquiring. */
export const STALE_LOCK_MIN_AGE_MS = 60_000;

/** The lock-ownership record written into a held lock directory. */
interface LockOwner {
  pid: number;
  startedAt: string;
  hostname: string;
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code as string | undefined : undefined;
}

/** A short, jittered delay so retries don't spin the event loop in a tight loop under contention (same shape as `store.ts`'s `backoffDelay`). */
function backoffDelay(attempt: number): Promise<void> {
  const ms = Math.min(5 + attempt * 5, 100) + Math.floor(Math.random() * 10);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Best-effort: records who holds `lockDir`. Never throws -- a failure here only degrades a future contender's ability to reclaim quickly (it falls back to the ownerless-and-stale path), it never affects whether THIS caller actually holds the lock (the exclusive `mkdir` already decided that). */
async function writeOwnerFile(lockDir: string): Promise<void> {
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname() };
  await writeFile(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner, null, 2), "utf8").catch(() => {});
}

/** Reads `lockDir`'s owner record. Returns `null` for "absent or unreadable/malformed" -- both fall back to the ownerless/stale-mtime reclaim path, never a thrown error (a torn or missing owner file must never block the retry loop). */
async function readOwnerFile(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string" && typeof parsed.hostname === "string") {
      return parsed as LockOwner;
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether `pid` is still alive on THIS host. `process.kill(pid, 0)` sends no signal; it only probes existence/permission. Only `ESRCH` ("no such process") is treated as dead -- any other outcome (success, or `EPERM` for a live process owned by another user) is treated as alive, so liveness checks never accidentally reclaim a lock a live process holds. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) !== "ESRCH";
  }
}

/**
 * Whether `lockDir` (which just lost a `mkdir` race with `EEXIST`) is
 * reclaimable -- see the module header for the exact rule. Read-only:
 * never mutates `lockDir`.
 */
async function isReclaimableStaleLock(lockDir: string): Promise<boolean> {
  const owner = await readOwnerFile(lockDir);
  if (owner) {
    if (owner.hostname !== hostname()) return false; // no cross-host liveness oracle -- never guess
    return !isProcessAlive(owner.pid);
  }
  const dirStat = await stat(lockDir).catch(() => null);
  if (!dirStat) return false; // vanished -- a concurrent reclaimer already freed it; just retry the mkdir
  return Date.now() - dirStat.mtimeMs >= STALE_LOCK_MIN_AGE_MS;
}

/**
 * Atomically reclaims `lockDir`, believed stale by {@link isReclaimableStaleLock}:
 * renames it aside (so at most one racing contender wins) and best-effort
 * removes the renamed-aside debris (it holds nothing but a stale
 * `owner.json`). Returns `true` on a successful reclaim (the caller should
 * retry `mkdir(lockDir)` immediately -- it is now free); `false` when this
 * contender lost the reclaim race (another contender's rename won, or the
 * directory vanished on its own), in which case the caller falls back to
 * ordinary backoff-and-retry.
 */
async function reclaimStaleLock(lockDir: string): Promise<boolean> {
  const tombstone = `${lockDir}.stale-${randomUUID()}`;
  try {
    await rename(lockDir, tombstone);
  } catch {
    return false;
  }
  // Best-effort cleanup of the reclaimed debris. A failed delete leaves only
  // a harmless, uniquely-named leftover directory -- never a correctness
  // problem -- so it is logged, never thrown.
  await rm(tombstone, { recursive: true, force: true }).catch((cleanupErr) => {
    console.error(`[file-lock] failed to remove reclaimed stale lock debris at '${tombstone}':`, cleanupErr);
  });
  return true;
}

/**
 * Runs `fn` while holding the mutex at `lockDir` — a directory used purely
 * as a lock; besides `owner.json` (this module's own bookkeeping) it never
 * holds caller content. Cross-process safe (see header).
 * Unresolvable contention surfaces the frozen `CONFLICT` error code rather
 * than silently dropping the caller's work.
 *
 * Keep `fn` to filesystem I/O only — anything slow should run BEFORE
 * acquiring the lock, so a long-held lock cannot wedge every other writer.
 *
 * `maxWaitMs` (default {@link FILE_LOCK_MAX_WAIT_MS}) is the wall-clock
 * budget to keep retrying before giving up -- overridable so tests can prove
 * the give-up behavior on a short, fast deadline instead of the real one
 * (Issue #115).
 */
export async function withFileLock<T>(
  lockDir: string,
  description: string,
  fn: () => Promise<T>,
  maxWaitMs: number = FILE_LOCK_MAX_WAIT_MS
): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < FILE_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      // Non-recursive, exclusive create: this IS the lock (same trick as
      // `claimNextSnapshotId`'s exclusive-mkdir id claim).
      await mkdir(lockDir);
    } catch (err) {
      if (isEexist(err)) {
        if (await isReclaimableStaleLock(lockDir)) {
          const reclaimed = await reclaimStaleLock(lockDir);
          if (reclaimed) continue; // retry mkdir(lockDir) immediately -- now unoccupied
        }
        if (Date.now() - startedAt >= maxWaitMs) break; // deadline reached -- fall through to CONFLICT
        await backoffDelay(attempt);
        continue; // another writer (this process or another) holds the lock; retry
      }
      throw err;
    }
    await writeOwnerFile(lockDir);
    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new ScadForgeError(
    "CONFLICT",
    `could not acquire the ${description} lock at '${lockDir}' after ${Date.now() - startedAt}ms (high write contention, or a lock held by a live owner)`
  );
}
