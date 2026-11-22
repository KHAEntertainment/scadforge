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
// hostname, token}`), written right after the winning `mkdir` (see the token
// notes below for what a failed write means). A
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
// ── WHY A PATH RENAME ALONE IS NOT ATOMIC RECLAIM (Issue #128) ───────────
//
// Deciding "stale" and then `rename(lockDir, tombstone)` are two separate
// steps, and a rename names a PATH, not a directory instance. Between the
// decision and the rename the stale directory can be reclaimed by another
// contender, which then `mkdir`s the same path and becomes a live holder; the
// late rename then moves THAT live lock away and admits a second holder. The
// rename is atomic; the decision it acts on is not. Reclaim is therefore
// serialized and the decision is re-made inside the serialization:
//
//   1. On a stale verdict a contender `mkdir`s a breaker whose name is unique
//      and carries its owner -- `<lockDir>.breaker-<hostTag>-<pid>-<uuid>`.
//      It always succeeds and is owned from the instant it exists, so there is
//      no ownerless gap and no breaker `owner.json`.
//   2. It then lists the sibling breakers of this lock. A breaker other than
//      its own whose name parses, whose host tag is this host, and whose pid
//      is provably dead (`ESRCH`) is removed by its exact name and ignored.
//      ANY other sibling (live pid -- including this process's own pid, for an
//      in-process contender -- another host, or an unparseable name) means
//      "contended": the contender removes its own breaker and returns to the
//      ordinary jittered backoff loop.
//   3. Uncontended, it holds the breaker: it re-runs the staleness check
//      fresh, renames and cleans up only if the lock is STILL stale, and
//      removes its own breaker in a `finally`.
//
// Why this excludes: for two contenders R1 and R2 to both pass step 2, each
// must list before the other's `mkdir`, but each does its own `mkdir` before
// its own list -- R1.mkdir < R1.list < R2.mkdir < R2.list < R1.mkdir is a
// cycle. There is no tie-break rule on names (a larger name may already have
// listed before a smaller one existed): both back off, and the jitter breaks
// the symmetry on the next round. Nothing is ever removed on an age or stale
// DECISION about a breaker (so a dead breaker cannot reintroduce this race one
// level up), and no breaker path is ever reused (the name is unique).
//
// Why the re-check is sufficient: a lock directory's contents only ever
// change by (a) its owner's release, or (b) a reclaim under the breaker. A
// stale verdict means the owner is provably dead (or ownerless for a minute),
// so (a) cannot happen to that instance between the re-check and the rename,
// and (b) is serialized by the breaker -- the path still names the instance
// that was inspected. The breaker is reached only after a stale verdict, so a
// lock held by a live owner pays no extra latency.
//
// Each acquisition also records a unique token (`randomUUID()`) in
// `owner.json`, written with an exclusive create (`wx`). If that write finds
// the file already there, or the directory gone, this acquirer lost the
// directory to a reclaimer while it was paused and simply retries. Release
// removes the lock ONLY if the token on disk is the caller's own; any other
// state (another token, no token -- an `owner.json` from a pre-token writer --
// a torn or absent file) is logged loudly and the directory is left alone.
// `owner.json` without a token stays readable, so staleness is decided
// exactly as before for old-shape records.
//
// RESIDUALS (honest limits, not guarantees):
//   - A LIVE acquirer paused for `STALE_LOCK_MIN_AGE_MS` or more between its
//     `mkdir` and its owner write can be reclaimed as an ownerless debris
//     directory. Its late exclusive owner write then either fails (the
//     successor already wrote its record: it retries) or lands in the
//     successor's still-ownerless directory (then the successor's own write
//     fails and the SUCCESSOR retries): at most one proceeds, but the late
//     acquirer can win the race. This is the pre-existing ownerless limit.
//   - pid reuse can wedge a reclaim: a dead lock owner or dead breaker whose
//     pid now belongs to an unrelated live process reads back as alive and is
//     never reclaimed, until that process exits. A live pid is never
//     overridden by age -- reclaiming a lock a live process holds would
//     corrupt its read-merge-write, which is strictly worse than a stuck one.
//   - A lock or breaker owned by ANOTHER host is never reclaimed; there is no
//     cross-host liveness oracle here.
//   - If a breaker's own removal fails (logged), its live pid keeps it
//     "contended" until this process exits.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { ScadForgeError } from "../errors.js";

// Deliberately NOT `import { performance } from "node:perf_hooks"`: that
// captures a stable module-scope binding to the real Performance object,
// which vitest's fake timers (Issue #115's own tests) cannot retarget --
// they replace `globalThis.performance`, not `perf_hooks`'s own export. The
// bare global identifier below re-reads `globalThis.performance` on every
// call, so it sees whichever object (real or faked) is current.

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

/** The lock-ownership record written into a held lock directory. `token` is optional on READ: an `owner.json` from a pre-token writer (or a hand-written fixture) lacks it and still drives staleness exactly as before. */
interface LockOwner {
  pid: number;
  startedAt: string;
  hostname: string;
  token?: string;
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

/**
 * Reduces a non-finite `maxWaitMs` (`NaN`, `Infinity`, `-Infinity`) to the
 * production default -- a non-finite value would otherwise make the deadline
 * comparison below never fire, falling through to `FILE_LOCK_MAX_ATTEMPTS`'s
 * ~19-20.5s count-based cap instead of the intended ~10s wall-clock one
 * (Issue #115). `0` and a negative value pass through UNCHANGED: both are
 * meaningful ("one attempt, then `CONFLICT`") the way non-finite is not.
 */
function clampMaxWaitMs(maxWaitMs: number): number {
  return Number.isFinite(maxWaitMs) ? maxWaitMs : FILE_LOCK_MAX_WAIT_MS;
}

/**
 * Records who holds `lockDir`, with an exclusive create (`wx`) so a late
 * writer can never clobber a successor's record. `"lost"` means the directory
 * is no longer this acquirer's (`EEXIST`: another record is already there;
 * `ENOENT`: the directory was reclaimed away) -- the caller must not touch it
 * and should retry. Any other failure is thrown: without a record there is no
 * token to verify at release, so the caller fails closed.
 */
async function writeOwnerFile(lockDir: string, token: string): Promise<"written" | "lost"> {
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), token };
  try {
    await writeFile(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner, null, 2), { encoding: "utf8", flag: "wx" });
    return "written";
  } catch (err) {
    const code = errorCode(err);
    if (code === "EEXIST" || code === "ENOENT") return "lost";
    throw err;
  }
}

/** Reads `lockDir`'s owner record. Returns `null` for "absent or unreadable/malformed" -- both fall back to the ownerless/stale-mtime reclaim path, never a thrown error (a torn or missing owner file must never block the retry loop). A record without a `token` (old shape) is returned with `token` undefined. */
async function readOwnerFile(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string" && typeof parsed.hostname === "string") {
      return { pid: parsed.pid, startedAt: parsed.startedAt, hostname: parsed.hostname, token: typeof parsed.token === "string" ? parsed.token : undefined };
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

const BREAKER_NAME_RE = /^([0-9a-f]{16})-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A filename-safe, fixed-length tag for this host, embedded in breaker names so a breaker can be attributed to a host without a record inside it. */
function hostTag(): string {
  return createHash("sha1").update(hostname()).digest("hex").slice(0, 16);
}

/** Whether another breaker for this lock makes this contender back off. Removes (by exact name) breakers whose owner is provably dead on this host; everything else is contention. A listing failure is contention too -- never proceed on an unverified view. */
async function breakerContended(lockDir: string, ownBreaker: string): Promise<boolean> {
  const dir = dirname(lockDir);
  const prefix = `${basename(lockDir)}.breaker-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return true;
  }
  let contended = false;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dir, name);
    if (path === ownBreaker) continue;
    const match = BREAKER_NAME_RE.exec(name.slice(prefix.length));
    if (match && match[1] === hostTag() && !isProcessAlive(Number(match[2]))) {
      // Provably dead holder: removed by its exact (never-reused) name.
      await rm(path, { recursive: true, force: true }).catch((cleanupErr) => {
        console.error(`[file-lock] failed to remove dead reclaim breaker '${path}':`, cleanupErr);
      });
      continue;
    }
    contended = true;
  }
  return contended;
}

/**
 * Reclaims `lockDir`, believed stale by {@link isReclaimableStaleLock}, under
 * the unique-name breaker described in the module header: the stale decision
 * is re-made while this contender is the only one reclaiming, and the rename
 * happens only if it still holds. Returns `true` when the stale directory was
 * renamed aside and removed (the caller should retry `mkdir(lockDir)`
 * immediately -- it is free); `false` when this contender backed off, the
 * lock turned out not to be stale any more (a successor holds it), or the
 * rename lost to the directory vanishing -- the caller falls back to ordinary
 * backoff-and-retry.
 */
async function reclaimStaleLock(lockDir: string): Promise<boolean> {
  const breaker = `${lockDir}.breaker-${hostTag()}-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(breaker);
  } catch {
    return false;
  }
  try {
    if (await breakerContended(lockDir, breaker)) return false;
    if (!(await isReclaimableStaleLock(lockDir))) return false; // re-check inside the serialization
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
  } finally {
    await rm(breaker, { recursive: true, force: true }).catch((cleanupErr) => {
      console.error(`[file-lock] failed to remove reclaim breaker '${breaker}':`, cleanupErr);
    });
  }
}

/**
 * Releases the lock at `lockDir` ONLY if the owner record on disk carries
 * `token` -- this caller's own. Anything else (another acquirer's token, an
 * old-shape record without a token, a torn or absent record) means the lock is
 * not provably ours any more, so it is left in place and logged loudly. Never
 * throws: by now `fn` has completed (or thrown) and neither outcome may be
 * masked by a release problem.
 */
async function releaseLock(lockDir: string, token: string): Promise<void> {
  const owner = await readOwnerFile(lockDir);
  if (owner?.token === token) {
    await rm(lockDir, { recursive: true, force: true }).catch((cleanupErr) => {
      console.error(`[file-lock] failed to remove released lock '${lockDir}':`, cleanupErr);
    });
    return;
  }
  const found = owner === null ? "no readable owner record (absent or torn)" : owner.token === undefined ? `an owner record without a token (pid ${owner.pid} on '${owner.hostname}')` : `token ${owner.token} (pid ${owner.pid} on '${owner.hostname}')`;
  console.error(
    `[file-lock] LOCK OWNERSHIP VIOLATION: not releasing '${lockDir}' -- expected this caller's token ${token} but found ${found}. ` +
      "The lock was taken over while this caller held it, so the critical section may have overlapped another holder; the directory is left in place."
  );
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
 * (Issue #115). Non-finite (`NaN`/`Infinity`) is clamped to the default; `0`
 * or negative means "one attempt, then `CONFLICT`" (see
 * {@link clampMaxWaitMs}). Elapsed time is measured with `performance.now()`
 * (monotonic), never `Date.now()` (wall-clock) -- a system clock adjustment
 * must never extend or shorten how long a caller actually waits.
 */
export async function withFileLock<T>(
  lockDir: string,
  description: string,
  fn: () => Promise<T>,
  maxWaitMs: number = FILE_LOCK_MAX_WAIT_MS
): Promise<T> {
  const effectiveMaxWaitMs = clampMaxWaitMs(maxWaitMs);
  const startedAt = performance.now();
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
        if (performance.now() - startedAt >= effectiveMaxWaitMs) break; // deadline reached -- fall through to CONFLICT
        await backoffDelay(attempt);
        continue; // another writer (this process or another) holds the lock; retry
      }
      throw err;
    }
    const token = randomUUID();
    let outcome: "written" | "lost";
    try {
      outcome = await writeOwnerFile(lockDir, token);
    } catch (err) {
      // Fail closed: without an owner record there is no token to verify at
      // release. Non-recursive on purpose -- only an EMPTY directory (ours,
      // seconds old) is removed.
      await rmdir(lockDir).catch(() => {});
      throw err;
    }
    if (outcome === "lost") {
      // The directory was reclaimed out from under this acquirer before its
      // owner write -- it is not ours; leave it alone and try again.
      if (performance.now() - startedAt >= effectiveMaxWaitMs) break;
      await backoffDelay(attempt);
      continue;
    }
    try {
      return await fn();
    } finally {
      await releaseLock(lockDir, token);
    }
  }
  throw new ScadForgeError(
    "CONFLICT",
    `could not acquire the ${description} lock at '${lockDir}' after ${Math.round(performance.now() - startedAt)}ms (high write contention, or a lock held by a live owner)`
  );
}
