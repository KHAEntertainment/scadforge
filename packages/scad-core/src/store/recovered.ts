// @scadforge/scad-core — the single mutable-project access boundary
// (Issue #73 / S3-B ticket B2).
//
// `withRecoveredProject(projectDir, fn)` is the ONLY public entry point that
// may acquire the project's params lock in order to read or write the
// project's coherent mutable state (root `model.scad`/`params.json`,
// `project.json`, and — from B4 — staged transactions). It:
//   1. Acquires the params lock (`params-lock.ts`, itself `file-lock.ts`'s
//      cross-process mkdir mutex with stale-owner reclaim).
//   2. Runs `recover(ctx)` — a STUB here; B4 fills it with staged-transaction
//      roll-forward recovery. Today it is a documented no-op, so every
//      caller already built against this exact shape needs no further
//      change once B4 lands.
//   3. Hands `fn` an opaque `LockedProject` context.
//
// Every writer and coherent reader migrated for this ticket (`store.ts`,
// `attachments.ts`, `apps/server/src/services/{scad-core-impl,
// agent-scad-core,runtime}.ts`) calls THIS function once at its own entry
// point, then passes the resulting `ctx` down to `ctx`-taking internal
// helpers defined alongside them — those helpers NEVER call
// `withRecoveredProject` again. This is the fix for the non-reentrancy that
// was previously enforced only by a comment (`store.ts`'s old
// `mergeParamsAtomic` header, Issue #44). Two layers enforce it now:
//
//   - RUNTIME (authoritative): an `AsyncLocalStorage` marks "inside a lock"
//     for the whole async call chain, for ANY project directory — not just
//     the same one a nested call names. A second `withRecoveredProject`
//     call anywhere in that chain throws `INTERNAL_ERROR` IMMEDIATELY,
//     before ever attempting the lock's `mkdir`, so an accidental nest never
//     burns through `FILE_LOCK_MAX_ATTEMPTS` retries waiting on a lock it
//     already holds. Nesting across two DIFFERENT projects is refused too —
//     the spec allows no nested params-lock acquisition, full stop, since
//     permitting it would invite lock-order deadlocks the moment two
//     boundaries interleave (B3/B4 may one day need two projects' locks in
//     one operation; that is a deliberately unsupported shape, not an
//     oversight).
//   - TYPE-LEVEL: `LockedProject` carries a module-private `unique symbol`
//     brand that only this file's own construction site can supply. No
//     `ctx`-taking helper, anywhere, can fabricate a second `LockedProject`
//     object literal from scratch — see `recovered.types.test.ts`. THIS is
//     the actual compile-time guarantee, not `withRecoveredProject`'s
//     `projectDir` parameter, which stays a plain `string` (the frozen
//     shared seam every future caller — B3, B4 — builds against). Do not
//     "tighten" that parameter to a branded path type later without
//     re-reading this note: the runtime guard above is what actually
//     prevents reentrancy; the brand only prevents forging a `ctx` to hand
//     to a `ctx`-taking helper out of turn.
//
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { ScadForgeError, withTypedError } from "../errors.js";
import { withParamsLock } from "./params-lock.js";

declare const LOCK_BRAND: unique symbol;

/**
 * Opaque, locked-project context. Only `withRecoveredProject` can construct
 * one — the `[LOCK_BRAND]` field is a module-private `unique symbol`, so no
 * code outside this file can write an object literal that satisfies this
 * type (see `recovered.types.test.ts`). `projectDir` itself stays a plain
 * `string` (the frozen shared seam), so every consumer downstream joins
 * paths off it exactly like any other project directory.
 */
export interface LockedProject {
  readonly projectDir: string;
  readonly [LOCK_BRAND]: true;
}

/**
 * Typed result for a locked reader that must distinguish ordinary legacy
 * absence (a pre-S3 project simply never had this file) from corruption
 * (the file exists but cannot be trusted) — the access-inventory fix this
 * ticket makes closed. `"absent"` behaves exactly like today's silent
 * empty/null defaults; `"corrupt"` is new and must never be treated as
 * `"absent"` by a caller.
 */
export type ReadResult<T> = { kind: "absent" } | { kind: "present"; value: T } | { kind: "corrupt"; error: ScadForgeError };

/**
 * Recovers any incomplete staged transaction for `ctx.projectDir` before the
 * caller's `fn` runs. STUB in this ticket — B4 (staged roll-forward
 * transactions) implements staged-transaction recovery here. Today it is a
 * documented no-op, so `withRecoveredProject`'s call shape (acquire lock,
 * recover, hand out `ctx`) is already exactly what every later ticket
 * builds against; landing B4 changes only this function's body.
 */
async function recover(_ctx: LockedProject): Promise<void> {
  // no-op — B4 fills this in.
}

/**
 * Tracks, for the current async call chain, the project directories already
 * locked by an ancestor `withRecoveredProject` call. See the module header
 * for why ANY nesting is refused, not just same-directory nesting.
 */
const activeLocks = new AsyncLocalStorage<ReadonlySet<string>>();

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code as string | undefined : undefined;
}

/**
 * The single public mutable-project access boundary (see module header).
 * Acquires the project's params lock, runs the (stub) recovery hook, and
 * hands `fn` an opaque `LockedProject`. Rejects only with a typed
 * `ScadForgeError`.
 */
export async function withRecoveredProject<T>(
  projectDir: string,
  fn: (ctx: LockedProject) => Promise<T>
): Promise<T> {
  const alreadyLocked = activeLocks.getStore();
  if (alreadyLocked) {
    throw new ScadForgeError(
      "INTERNAL_ERROR",
      `withRecoveredProject('${projectDir}') was called while already inside a lock for ` +
        `'${[...alreadyLocked].join("', '")}' on the same async chain — the params lock is not ` +
        "reentrant, and nesting is refused even across different projects to avoid lock-order " +
        "deadlocks. A ctx-taking helper must take the existing LockedProject instead of re-entering " +
        "the boundary."
    );
  }

  return withTypedError(
    () =>
      withParamsLock(projectDir, () =>
        activeLocks.run(new Set([projectDir]), async () => {
          const ctx: LockedProject = { projectDir } as LockedProject; // the ONLY place this cast may appear
          await recover(ctx);
          return fn(ctx);
        })
      ).catch((err) => {
        // The lock directory (`.scadforge/params.lock`) is a non-recursive
        // `mkdir` under `.scadforge/` (file-lock.ts): if `.scadforge/`
        // itself does not exist, that `mkdir` fails `ENOENT` rather than
        // `EEXIST`, which can only mean `projectDir` is not an initialized
        // project (every real project's `.scadforge/` is created once by
        // `initProject`, before this boundary is ever reachable for it).
        // Report the honest, specific error instead of a generic
        // `INTERNAL_ERROR` wrapping a raw filesystem code -- this is what
        // lets every caller drop the separate unlocked "does the project
        // exist" pre-check the old code needed before it dared enter the
        // lock.
        if (errorCode(err) === "ENOENT") {
          throw new ScadForgeError("PROJECT_NOT_FOUND", `project not found at '${projectDir}'`, { cause: err });
        }
        throw err;
      }),
    "INTERNAL_ERROR",
    `failed to acquire the recovery boundary for '${projectDir}'`
  );
}
