// SPDX-License-Identifier: Apache-2.0
//
// Type-level test (Issue #73 AC1): a `LockedProject` cannot be fabricated
// outside `recovered.ts`. This is checked by `pnpm -r build` (`tsc`): if the
// `@ts-expect-error` directive below stops being a real type error — e.g.
// because the brand were accidentally exported, or removed — `tsc` fails
// the build with "Unused '@ts-expect-error' directive", so the build itself
// enforces this, not only this file's own `vitest run`.
//
// This is the ACTUAL compile-time guarantee `recovered.ts` provides, and is
// deliberately narrower than "calling withRecoveredProject again is a
// compile error": `LockedProject.projectDir` stays a plain `string` (the
// frozen shared seam), so a `ctx`-taking helper CAN legally pass
// `ctx.projectDir` to `withRecoveredProject` and have it type-check — that
// misuse is caught at RUNTIME instead, immediately, by the
// `AsyncLocalStorage` reentrancy guard (see `recovered.test.ts`). See
// `recovered.ts`'s module header for the full rationale; do not "tighten"
// this file to also reject that call without re-reading it first.

import { describe, expect, it } from "vitest";
import type { LockedProject } from "./recovered.js";

/**
 * A `ctx`-taking helper receives a `LockedProject` from its caller but can
 * never mint a second one from scratch — the brand is a module-private
 * `unique symbol`, invisible outside `recovered.ts`, so no object literal
 * anywhere else can satisfy this interface.
 */
function attemptToFabricateLockedProject(ctx: LockedProject): LockedProject {
  // @ts-expect-error LockedProject's brand is a module-private `unique
  // symbol` not exported by recovered.ts, so this object literal — built
  // from nothing but ctx's own public `projectDir` — is missing the one
  // property only withRecoveredProject can supply.
  const fabricated: LockedProject = { projectDir: ctx.projectDir };
  return fabricated;
}

describe("LockedProject is opaque outside recovered.ts (Issue #73 AC1, type-level)", () => {
  it("only compiles because the @ts-expect-error above is a genuine type error -- see this file's header", () => {
    // A runtime assertion so this function is not dead code a bundler could
    // elide before `tsc` ever type-checks it; the real assertion is the
    // `@ts-expect-error` directive itself, enforced by `pnpm -r build`.
    expect(typeof attemptToFabricateLockedProject).toBe("function");
  });
});
