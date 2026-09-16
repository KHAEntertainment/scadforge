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
// The lock itself is `file-lock.ts`'s generic atomic-mkdir mutex (Issue #48
// lifted it one level so the exports ledger could share it): non-recursive
// `mkdir` is atomic at the filesystem/OS level, so exactly one caller --
// in-process or cross-process, same machine (required: the GUI server and,
// from M4, the stdio MCP server share one `.scadforge/` tree) -- ever wins.
//
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { FILE_LOCK_MAX_ATTEMPTS, withFileLock } from "./file-lock.js";
import { metaDir } from "./paths.js";

/** Max attempts to acquire the params lock before failing with `CONFLICT` — kept in lockstep with the shared retry loop (`file-lock.ts`). */
export const PARAMS_LOCK_MAX_ATTEMPTS = FILE_LOCK_MAX_ATTEMPTS;

/** `.scadforge/params.lock` — a directory used purely as a mutex; it never holds file content. */
function paramsLockDir(projectDir: string): string {
  return join(metaDir(projectDir), "params.lock");
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
 *
 * `maxWaitMs` (default {@link FILE_LOCK_MAX_WAIT_MS} via `withFileLock`) is
 * an optional override of the wall-clock give-up budget -- additive, for
 * tests only (Issue #115); production callers never pass it.
 */
export async function withParamsLock<T>(projectDir: string, fn: () => Promise<T>, maxWaitMs?: number): Promise<T> {
  return withFileLock(paramsLockDir(projectDir), "params", fn, maxWaitMs);
}
