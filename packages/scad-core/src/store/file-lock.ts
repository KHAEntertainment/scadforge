// @scadforge/scad-core — generic cross-process file lock (Issue #48).
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
// SPDX-License-Identifier: Apache-2.0

import { mkdir, rm } from "node:fs/promises";
import { ScadForgeError } from "../errors.js";

/** Max attempts to acquire a file lock before failing with `CONFLICT` (mirrors `SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS`). */
export const FILE_LOCK_MAX_ATTEMPTS = 50;

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

/** A short, jittered delay so retries don't spin the event loop in a tight loop under contention (same shape as `store.ts`'s `backoffDelay`). */
function backoffDelay(attempt: number): Promise<void> {
  const ms = Math.min(5 + attempt * 5, 100) + Math.floor(Math.random() * 10);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Runs `fn` while holding the mutex at `lockDir` — a directory used purely
 * as a lock; it never holds file content. Cross-process safe (see header).
 * Unresolvable contention surfaces the frozen `CONFLICT` error code rather
 * than silently dropping the caller's work.
 *
 * Keep `fn` to filesystem I/O only — anything slow should run BEFORE
 * acquiring the lock, so a long-held lock cannot wedge every other writer.
 */
export async function withFileLock<T>(lockDir: string, description: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < FILE_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      // Non-recursive, exclusive create: this IS the lock (same trick as
      // `claimNextSnapshotId`'s exclusive-mkdir id claim).
      await mkdir(lockDir);
    } catch (err) {
      if (isEexist(err)) {
        if (attempt < FILE_LOCK_MAX_ATTEMPTS - 1) await backoffDelay(attempt);
        continue; // another writer (this process or another) holds the lock; retry
      }
      throw err;
    }
    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new ScadForgeError(
    "CONFLICT",
    `could not acquire the ${description} lock at '${lockDir}' after ${FILE_LOCK_MAX_ATTEMPTS} attempts (high write contention)`
  );
}
