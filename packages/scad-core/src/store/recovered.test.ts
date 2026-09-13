// SPDX-License-Identifier: Apache-2.0
//
// `withRecoveredProject` (Issue #73 / S3-B ticket B2): the runtime
// non-reentrancy guard, and basic ctx plumbing. See `recovered.types.test.ts`
// for the companion compile-time guarantee (LockedProject is opaque).

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRecoveredProject } from "./recovered.js";
import { metaDir } from "./paths.js";

let projectDirA: string;
let projectDirB: string;

beforeEach(async () => {
  projectDirA = await mkdtemp(join(tmpdir(), "scadcore-recovered-test-a-"));
  projectDirB = await mkdtemp(join(tmpdir(), "scadcore-recovered-test-b-"));
  // withRecoveredProject's lock is a non-recursive mkdir under `.scadforge/`
  // (file-lock.ts) -- these tests exercise the boundary itself, not
  // initProject's own "meta dir doesn't exist yet" special case (that is
  // covered by store.test.ts), so pre-create it exactly like an already
  // -initialized project would have.
  await mkdir(metaDir(projectDirA), { recursive: true });
  await mkdir(metaDir(projectDirB), { recursive: true });
});

afterEach(async () => {
  await rm(projectDirA, { recursive: true, force: true });
  await rm(projectDirB, { recursive: true, force: true });
});

describe("withRecoveredProject", () => {
  it("a projectDir with no .scadforge/ (not an initialized project) fails PROJECT_NOT_FOUND, not a generic INTERNAL_ERROR", async () => {
    const uninitialized = await mkdtemp(join(tmpdir(), "scadcore-recovered-test-uninit-"));
    try {
      await expect(withRecoveredProject(uninitialized, async () => "should never run")).rejects.toMatchObject({
        error_code: "PROJECT_NOT_FOUND"
      });
    } finally {
      await rm(uninitialized, { recursive: true, force: true });
    }
  });

  it("hands fn a ctx whose projectDir matches the input", async () => {
    const seen = await withRecoveredProject(projectDirA, async (ctx) => ctx.projectDir);
    expect(seen).toBe(projectDirA);
  });

  it("returns fn's resolved value", async () => {
    const result = await withRecoveredProject(projectDirA, async () => 42);
    expect(result).toBe(42);
  });

  it("propagates fn's rejection", async () => {
    await expect(
      withRecoveredProject(projectDirA, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });

  it("releases the lock after fn resolves -- a second, sequential call succeeds", async () => {
    await withRecoveredProject(projectDirA, async () => "first");
    const second = await withRecoveredProject(projectDirA, async () => "second");
    expect(second).toBe("second");
  });

  it("releases the lock after fn rejects -- a subsequent call is not wedged", async () => {
    await withRecoveredProject(projectDirA, async () => {
      throw new Error("boom");
    }).catch(() => {});
    const after = await withRecoveredProject(projectDirA, async () => "recovered");
    expect(after).toBe("recovered");
  });

  it("nesting withRecoveredProject for the SAME projectDir on the same async chain throws INTERNAL_ERROR immediately, never after the 50-attempt backoff ceiling", async () => {
    const start = Date.now();
    await expect(
      withRecoveredProject(projectDirA, async () =>
        withRecoveredProject(projectDirA, async () => "should never run")
      )
    ).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });
    // Immediate, not the ~50 * up-to-110ms backoff loop a real mkdir EEXIST
    // contention would take (multiple seconds -- see file-lock.test.ts).
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("nesting withRecoveredProject for a DIFFERENT projectDir on the same async chain is ALSO refused -- no nested params-lock acquisition, full stop", async () => {
    await expect(
      withRecoveredProject(projectDirA, async () =>
        withRecoveredProject(projectDirB, async () => "should never run")
      )
    ).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });
  });

  it("the reentrancy error names both the already-locked directory and the newly attempted one", async () => {
    await expect(
      withRecoveredProject(projectDirA, async () => withRecoveredProject(projectDirB, async () => "x"))
    ).rejects.toThrow(new RegExp(`${projectDirA}.*${projectDirB}|${projectDirB}.*${projectDirA}`, "s"));
  });

  it("two SEPARATE, non-nested calls for different projects run concurrently without tripping the reentrancy guard", async () => {
    const [a, b] = await Promise.all([
      withRecoveredProject(projectDirA, async () => "a-done"),
      withRecoveredProject(projectDirB, async () => "b-done")
    ]);
    expect(a).toBe("a-done");
    expect(b).toBe("b-done");
  });

  it("two SEPARATE, non-nested concurrent calls for the SAME project both eventually succeed -- serialized by the real file lock, not refused by the reentrancy guard", async () => {
    const order: string[] = [];
    const [a, b] = await Promise.all([
      withRecoveredProject(projectDirA, async () => {
        order.push("a");
        return "a-done";
      }),
      withRecoveredProject(projectDirA, async () => {
        order.push("b");
        return "b-done";
      })
    ]);
    expect(a).toBe("a-done");
    expect(b).toBe("b-done");
    expect(order.sort()).toEqual(["a", "b"]);
  });
});
