// @scadforge/scad-core — cross-process mutex protecting every writer of the
// project's root `params.json` (Issue #44).
//
// `params.json` is read, merged, and written with no coordination between
// concurrent callers: two writers touching DISJOINT keys (an agent's
// `set_params` and a REST `PUT .../params`, or two rapid slider-drag REST
// calls) each read the SAME "current" value, each merge in only their OWN
// key, and whichever writer's file write lands LAST wins wholesale --
// silently discarding the other's change. No torn write, just a lost update.
//
// This reuses the SAME primitive the M1 snapshot store already validated for
// cross-process safety (`store.ts`'s CONCURRENCY POLICY / `claimNextSnapshotId`):
// a non-recursive `mkdir` is atomic at the filesystem/OS level, so exactly
// one caller -- in-process or cross-process, same machine (required: the GUI
// server and, from M4, the stdio MCP server share one `.scadforge/` tree) --
// ever wins the `mkdir` for a given path; every other concurrent caller gets
// `EEXIST` and must retry. Here it is used as a plain mutex (acquire / run /
// release) rather than an id-claim, because `params.json` is a single shared
// mutable file, not a set of independently-claimable numbered slots.
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ScadForgeError } from "../errors.js";
import { metaDir } from "./paths.js";

/** `.scadforge/params.lock` — a directory used purely as a mutex; it never holds file content. */
function paramsLockDir(projectDir: string): string {
  return join(metaDir(projectDir), "params.lock");
}

/** Max attempts to acquire the params lock before failing with `CONFLICT` (mirrors `SNAPSHOT_ID_CLAIM_MAX_ATTEMPTS`). */
export const PARAMS_LOCK_MAX_ATTEMPTS = 50;

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

/** A short, jittered delay so retries don't spin the event loop in a tight loop under contention (same shape as `store.ts`'s `backoffDelay`). */
function backoffDelay(attempt: number): Promise<void> {
  const ms = Math.min(5 + attempt * 5, 100) + Math.floor(Math.random() * 10);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function acquireParamsLock(projectDir: string): Promise<void> {
  const dir = paramsLockDir(projectDir);
  for (let attempt = 0; attempt < PARAMS_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      // Non-recursive, exclusive create: this IS the lock (same trick as
      // `claimNextSnapshotId`'s exclusive-mkdir id claim).
      await mkdir(dir);
      return;
    } catch (err) {
      if (isEexist(err)) {
        if (attempt < PARAMS_LOCK_MAX_ATTEMPTS - 1) await backoffDelay(attempt);
        continue; // another writer (this process or another) holds the lock; retry
      }
      throw err;
    }
  }
  throw new ScadForgeError(
    "CONFLICT",
    `could not acquire the params lock in '${projectDir}' after ${PARAMS_LOCK_MAX_ATTEMPTS} attempts (high write contention)`
  );
}

async function releaseParamsLock(projectDir: string): Promise<void> {
  await rm(paramsLockDir(projectDir), { recursive: true, force: true }).catch(() => {});
}

/**
 * Runs `fn` while holding the project's params lock — a cross-process mutex
 * (see header). Every writer that reads the CURRENT `params.json` in order to
 * merge a new value onto it (a standalone params-only update, or a
 * `set_params`/`write_scad`-driven snapshot that carries params forward) must
 * do so inside this lock, so two concurrent updates to DISJOINT keys can
 * never race: the second writer always observes the first's already-
 * committed change.
 *
 * Keep `fn` to the read-merge-write itself (filesystem I/O only) — anything
 * slow (an OpenSCAD subprocess call to fetch the live Customizer schema, say)
 * should run BEFORE acquiring the lock, so rapid successive writes (a
 * slider-drag pattern) never degrade into a long lock-held chain, and a
 * crashed holder cannot wedge every other writer for long either.
 */
export async function withParamsLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  await acquireParamsLock(projectDir);
  try {
    return await fn();
  } finally {
    await releaseParamsLock(projectDir);
  }
}
