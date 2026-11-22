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
// ── THE OWNER RECORD IS THE ARBITER (Issue #128) ─────────────────────────
//
// `mkdir` creates a directory INSTANCE at `lockDir`; by itself it does not say
// who may run `fn`. The holder of an instance is whoever PUBLISHES its
// `owner.json` (`{pid, startedAt, hostname, token}`, the token a fresh
// `randomUUID()` per acquisition), and an instance accepts at most ONE
// publication. Publication is exclusive AND atomic: the full record is written
// to a uniquely named temp file inside the directory, then
// `link(temp, owner.json)` -- which fails `EEXIST` if a record is already
// there -- and the temp file is unlinked. A reader therefore sees no record or
// a complete one, never a torn one, and a leftover temp file is never a record
// (only `owner.json` is read). `EEXIST` or `ENOENT` on publication means
// "lost": the instance belongs to someone else, or is gone, and the caller
// retries. Any other publication error fails closed (the caller's own empty
// directory is removed with a non-recursive `rmdir`, the raw error is
// rethrown). `fn` runs ONLY for a publisher.
//
// ── STALE-OWNER RECLAIM (Issue #73) ──────────────────────────────────────
//
// Before #73, a process that died while holding a lock (a hard kill, an OOM)
// wedged every future writer of that resource forever: the `finally` that
// removes the directory never runs. A contender that sees `EEXIST` now
// classifies the instance:
//   - a readable record naming ANOTHER host: never touched -- there is no
//     cross-host liveness oracle, and guessing wrong would let two machines
//     both believe they hold the same lock.
//   - a readable record naming a pid on THIS host that is not alive
//     (`process.kill(pid, 0)` throws `ESRCH`): the owner crashed. RECLAIM by
//     rename, under the breaker below.
//   - no record and the directory's mtime younger than
//     `STALE_LOCK_MIN_AGE_MS`: its creator may simply not have published yet.
//     Hold off.
//   - no record and the directory at least `STALE_LOCK_MIN_AGE_MS` old: the
//     creator died between `mkdir` and publication. ADOPT it (below).
//   - an `owner.json` that was READ successfully but is torn or invalid, and
//     the directory at least `STALE_LOCK_MIN_AGE_MS` old: RECLAIM by rename,
//     under the breaker. This is a legacy/corruption path only -- publication
//     above never produces it.
//   - an `owner.json` whose READ FAILS (`EIO`, `EACCES`, `EMFILE`, ...): hold
//     off, always. A failed read says nothing about the record (it may belong
//     to a live holder), so it is never reclaimed and never adopted -- the
//     same principle as the other-host rule: no oracle, never guess.
//   - anything else (a live pid): hold off, backoff, retry until
//     `FILE_LOCK_MAX_WAIT_MS`.
//
// WHY AN OWNERLESS DIRECTORY IS ADOPTED, NEVER RENAMED. The creator of an
// ownerless directory may be alive, merely paused for a minute. Renaming it
// would authorize a move of an instance the creator can still publish into
// and then use: the creator's late publication succeeds, and the rename that
// was already authorized removes a now-LIVE lock. So the reclaimer does not
// rename; it publishes ITS OWN record into that same directory with the same
// exclusive publication. Whoever links first holds the lock; the other gets
// `EEXIST` and retries. The record, not a stale decision, picks the winner.
// Adopting an instance that changed under the decision is equally safe: the
// instance still takes at most one publication.
//
// WHY A PATH RENAME ALONE IS NOT ATOMIC RECLAIM. Where rename IS used (a dead
// owner's record, an unreadable record older than the age limit), "decide
// stale" and `rename(lockDir, tombstone)` are still two steps, and a rename
// names a PATH, not an instance: between them another contender can reclaim
// the stale directory and `mkdir` a new live one at the same path, and the
// late rename would move THAT away. Reclaim is therefore serialized and the
// decision re-made inside the serialization:
//   1. On a rename verdict a contender `mkdir`s a breaker whose name is unique
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
//   3. Uncontended, it holds the breaker: it re-runs the classification fresh,
//      renames and cleans up only if the verdict is STILL "reclaim", and
//      removes its own breaker in a `finally`.
// For two contenders R1 and R2 to both pass step 2, each must list before the
// other's `mkdir`, but each does its own `mkdir` before its own list --
// R1.mkdir < R1.list < R2.mkdir < R2.list < R1.mkdir is a cycle. There is no
// tie-break on names (a larger name may already have listed before a smaller
// one existed): both back off and the jitter breaks the symmetry next round.
// Nothing is removed on an age or stale DECISION about a breaker (so a dead
// breaker cannot reintroduce this race one level up) and no breaker path is
// ever reused. The re-check is sufficient because a "reclaim" verdict cannot
// change underneath the rename: a dead pid stays dead, and a published record
// is never rewritten.
//
// Release is atomic too. After the token check the lock is renamed to a
// unique `<lockDir>.released-<uuid>` tombstone, which is then removed. A
// recursive `rm` of the lock path would unlink `owner.json` first and leave a
// record-less directory a late publisher could still publish into.
// Release removes the lock ONLY if the token on disk is the caller's own; any
// other state (another token, no token -- an `owner.json` from a pre-token
// writer -- a torn or absent file) is logged loudly and the directory is left
// alone. `owner.json` without a token stays readable, so liveness is decided
// exactly as before for old-shape records.
//
// GUARANTEE: at most one caller is inside `fn` for a lock path at any time, so
// long as every writer of that path runs this module (see mixed-version
// below), a dead owner's pid is not live, and the filesystem supports hard
// links (publication fails closed, never silently weaker, where it does not).
//
// RESIDUALS (honest limits, not guarantees):
//   - pid reuse can wedge a reclaim: a dead lock owner or dead breaker whose
//     pid now belongs to an unrelated live process reads back as alive and is
//     never reclaimed, until that process exits. A live pid is never
//     overridden by age -- reclaiming a lock a live process holds would
//     corrupt its read-merge-write, which is strictly worse than a stuck one.
//   - A lock or breaker owned by ANOTHER host is never reclaimed.
//   - A legacy or corrupted UNREADABLE record older than the age limit is
//     reclaimed by rename. New publication never produces one, but a pre-fix
//     writer paused mid-write for that long can: its later write lands in the
//     renamed-away directory and it believes it still holds the lock.
//   - A record whose read keeps failing (a permissions fault, a failing disk)
//     is never reclaimed or adopted: the lock fails closed and needs an
//     operator to remove the directory.
//   - Release verifies the token before removing the lock. If reading the
//     record fails at release (say `EMFILE` under file-descriptor pressure)
//     the read is retried a few times (5 retries, 25 ms apart); if it still
//     fails the lock is LEFT IN PLACE, naming this live process, and the log
//     says so (`[file-lock] could not VERIFY ownership of '<lockDir>' at
//     release ...`). Later callers then see `CONFLICT` until this process
//     restarts or the directory is removed. Never thrown, never masks `fn`.
//   - Mixed-version writers: a pre-fix or `main` build never publishes a
//     record (or publishes a non-atomic one) and holds an ownerless directory
//     for its whole critical section. Once that has lasted
//     `STALE_LOCK_MIN_AGE_MS` it is indistinguishable from debris and is
//     adopted, exactly the pre-existing ownerless limit.
//   - If a breaker's own removal fails, the failure is logged
//     (`[file-lock] failed to remove reclaim breaker '<path>':`) and the
//     breaker, which names this still-live process, blocks later
//     rename-based reclaims of this lock until the process exits. This
//     fails closed (availability only): own-pid breakers are deliberately not
//     exempted, because an in-process contender's live breaker is
//     indistinguishable from a leaked one. Adoption and live-owner waits are
//     unaffected.
//
// SPDX-License-Identifier: Apache-2.0

import { link, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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

/** Release re-reads the owner record this many times after a FAILED read (not an absent or invalid one), `RELEASE_READ_RETRY_DELAY_MS` apart -- about 125 ms in all. */
const RELEASE_READ_RETRIES = 5;
const RELEASE_READ_RETRY_DELAY_MS = 25;

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
 * Publishes this acquirer's owner record into `lockDir`: exclusive (at most
 * one publication per directory instance) and atomic (never visible half
 * written) -- the full record goes to a uniquely named temp file inside the
 * directory, `link(temp, owner.json)` fails `EEXIST` if a record is already
 * there, and the temp file is always unlinked afterwards. `"lost"` means the
 * directory is no longer this acquirer's to publish into (`EEXIST`: another
 * record is already there; `ENOENT`: the directory was removed) -- the caller
 * must not touch it and should retry. Any other failure is thrown, and when
 * `ownsEmptyDir` (this caller just `mkdir`ed `lockDir`) its still-empty
 * directory is removed with a non-recursive `rmdir` first: without a record
 * there is no token to verify at release, so the caller fails closed.
 */
async function publishOwnerFile(lockDir: string, token: string, ownsEmptyDir: boolean): Promise<"written" | "lost"> {
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), token };
  const tempPath = join(lockDir, `${LOCK_OWNER_FILE}.tmp-${randomUUID()}`);
  try {
    await writeFile(tempPath, JSON.stringify(owner, null, 2), { encoding: "utf8", flag: "wx" });
    await link(tempPath, join(lockDir, LOCK_OWNER_FILE));
    return "written";
  } catch (err) {
    const code = errorCode(err);
    if (code === "EEXIST" || code === "ENOENT") return "lost";
    await unlink(tempPath).catch(() => {});
    if (ownsEmptyDir) await rmdir(lockDir).catch(() => {});
    throw err;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * What reading `lockDir`'s owner record found: a complete record; none at all
 * (`ENOENT`/`ENOTDIR`); a file that was READ but is torn, malformed or the
 * wrong shape (`unreadable`); or a read that FAILED (`read-failed`: `EIO`,
 * `EACCES`, `EMFILE`, ... -- nothing is known about the record, so it must
 * never be treated as stale, ownerless or someone else's).
 */
type OwnerRead = { state: "record"; owner: LockOwner } | { state: "absent" } | { state: "unreadable" } | { state: "read-failed"; code: string };

async function readOwnerState(lockDir: string): Promise<OwnerRead> {
  let raw: string;
  try {
    raw = await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8");
  } catch (err) {
    const code = errorCode(err);
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "absent" } : { state: "read-failed", code: code ?? "UNKNOWN" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string" && typeof parsed.hostname === "string") {
      return { state: "record", owner: { pid: parsed.pid, startedAt: parsed.startedAt, hostname: parsed.hostname, token: typeof parsed.token === "string" ? parsed.token : undefined } };
    }
  } catch {
    // fall through: torn or malformed
  }
  return { state: "unreadable" };
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

/** What a contender that lost the `mkdir` race should do about the existing lock -- see the module header. */
type LockVerdict = "hold-off" | "reclaim" | "adopt";

/**
 * Classifies `lockDir` (which just lost a `mkdir` race with `EEXIST`).
 * Read-only: never mutates `lockDir`. `"reclaim"` (rename-aside under the
 * breaker) is returned only for verdicts that cannot change underneath the
 * rename; an ownerless directory is `"adopt"` (publish into it), never
 * renamed.
 */
async function lockVerdict(lockDir: string): Promise<LockVerdict> {
  const read = await readOwnerState(lockDir);
  if (read.state === "read-failed") return "hold-off"; // cannot judge -- never reclaim or adopt on a failed read
  if (read.state === "record") {
    if (read.owner.hostname !== hostname()) return "hold-off"; // no cross-host liveness oracle -- never guess
    return isProcessAlive(read.owner.pid) ? "hold-off" : "reclaim";
  }
  const dirStat = await stat(lockDir).catch(() => null);
  if (!dirStat) return "hold-off"; // vanished -- a concurrent holder already released it; just retry the mkdir
  if (Date.now() - dirStat.mtimeMs < STALE_LOCK_MIN_AGE_MS) return "hold-off"; // its creator may not have published yet
  return read.state === "absent" ? "adopt" : "reclaim";
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
 * Reclaims `lockDir` by rename (verdict `"reclaim"` of {@link lockVerdict}), under
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
    if ((await lockVerdict(lockDir)) !== "reclaim") return false; // re-check inside the serialization
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
  let read = await readOwnerState(lockDir);
  // A failed READ (EMFILE under fd pressure, EIO, ...) says nothing about who
  // owns the lock: retry a bounded number of times before giving up, so a
  // transient fault cannot strand a lock naming this live process.
  for (let retry = 0; retry < RELEASE_READ_RETRIES && read.state === "read-failed"; retry++) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, RELEASE_READ_RETRY_DELAY_MS));
    read = await readOwnerState(lockDir);
  }
  if (read.state === "read-failed") {
    console.error(
      `[file-lock] could not VERIFY ownership of '${lockDir}' at release: its owner record could not be read (${read.code}) after ${RELEASE_READ_RETRIES + 1} attempts. ` +
        `The lock was left in place naming this live process (pid ${process.pid}); later callers will see CONFLICT until this process restarts or the directory is removed.`
    );
    return;
  }
  const owner = read.state === "record" ? read.owner : null;
  if (owner?.token === token) {
    // One atomic rename takes the lock path out of the namespace with the
    // record still inside it; only then is the debris removed.
    const tombstone = `${lockDir}.released-${randomUUID()}`;
    try {
      await rename(lockDir, tombstone);
    } catch (releaseErr) {
      console.error(`[file-lock] failed to release lock '${lockDir}':`, releaseErr);
      return;
    }
    await rm(tombstone, { recursive: true, force: true }).catch((cleanupErr) => {
      console.error(`[file-lock] failed to remove released lock debris at '${tombstone}':`, cleanupErr);
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
    let created = false;
    try {
      // Non-recursive, exclusive create of the directory INSTANCE (same trick
      // as `claimNextSnapshotId`'s exclusive-mkdir id claim). Holding the
      // lock additionally needs this instance's single publication below.
      await mkdir(lockDir);
      created = true;
    } catch (err) {
      if (!isEexist(err)) throw err;
    }
    const token = randomUUID();
    let outcome: "written" | "lost" | "held-off" = "held-off";
    if (created) {
      outcome = await publishOwnerFile(lockDir, token, true);
    } else {
      const verdict = await lockVerdict(lockDir);
      if (verdict === "adopt") {
        outcome = await publishOwnerFile(lockDir, token, false);
      } else if (verdict === "reclaim" && (await reclaimStaleLock(lockDir))) {
        continue; // retry mkdir(lockDir) immediately -- now unoccupied
      }
    }
    if (outcome === "written") {
      try {
        return await fn();
      } finally {
        await releaseLock(lockDir, token);
      }
    }
    // Held by a live owner, lost the publication, or lost the reclaim race:
    // another writer (this process or another) holds it; back off and retry.
    if (performance.now() - startedAt >= effectiveMaxWaitMs) break; // deadline reached -- fall through to CONFLICT
    await backoffDelay(attempt);
  }
  throw new ScadForgeError(
    "CONFLICT",
    `could not acquire the ${description} lock at '${lockDir}' after ${Math.round(performance.now() - startedAt)}ms (high write contention, or a lock held by a live owner)`
  );
}
