import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";
import { initProject, mergeParamsAtomic } from "./store.js";
import { rootParamsPath } from "./paths.js";
import { PARAMS_LOCK_MAX_ATTEMPTS, withParamsLock } from "./params-lock.js";

let projectDir: string;

const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

async function readRootParams(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(rootParamsPath(projectDir), "utf8"));
  return raw.parameterSets.current;
}

/** A `persist` callback that actually commits `merged` to disk, mirroring what a real caller (`createSnapshot`/`writeRootParams`) does. */
async function persistToDisk(merged: Record<string, unknown>): Promise<Record<string, unknown>> {
  await writeFile(
    rootParamsPath(projectDir),
    JSON.stringify({ fileFormatVersion: 1, parameterSets: { current: merged } }, null, 2),
    "utf8"
  );
  return merged;
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-params-lock-test-"));
  await initProject(projectDir, { id: "p", name: "n", provider: providerConfig, content: "cube(1);\n" });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("mergeParamsAtomic (Issue #44)", () => {
  it("N concurrent updates to N disjoint keys all survive -- no lost update", async () => {
    const N = 15;
    await Promise.all(
      Array.from({ length: N }, (_, i) => mergeParamsAtomic(projectDir, { [`k${i}`]: i }, persistToDisk))
    );

    const values = await readRootParams();
    for (let i = 0; i < N; i++) {
      expect(values[`k${i}`]).toBe(i);
    }
  });

  it("persist's write and the read it merged onto happen atomically -- a slow persist never lets another writer's read-merge-write interleave", async () => {
    const writes: string[] = [];
    async function slowPersist(label: string, delayMs: number, key: string, value: number) {
      return mergeParamsAtomic(projectDir, { [key]: value }, async (merged) => {
        writes.push(`${label}-start`);
        await new Promise((r) => setTimeout(r, delayMs));
        await writeFile(
          rootParamsPath(projectDir),
          JSON.stringify({ fileFormatVersion: 1, parameterSets: { current: merged } }, null, 2),
          "utf8"
        );
        writes.push(`${label}-end`);
        return merged;
      });
    }

    await Promise.all([slowPersist("A", 30, "a", 1), slowPersist("B", 5, "b", 2)]);

    // Whichever ran first, its start/end pair is never interleaved with the
    // other's -- the lock serializes the two critical sections completely.
    const aStart = writes.indexOf("A-start");
    const aEnd = writes.indexOf("A-end");
    const bStart = writes.indexOf("B-start");
    const bEnd = writes.indexOf("B-end");
    const aBeforeB = aEnd < bStart;
    const bBeforeA = bEnd < aStart;
    expect(aBeforeB || bBeforeA).toBe(true);

    expect(await readRootParams()).toEqual({ a: 1, b: 2 });
  });

  it("exhausting PARAMS_LOCK_MAX_ATTEMPTS surfaces the typed CONFLICT error, never a silent drop", async () => {
    // Pre-claim the lock directory and never release it -- simulates
    // pathological contention (mirrors store.test.ts's analogous snapshot-id
    // CONFLICT test).
    const lockDir = join(projectDir, PROJECT_LAYOUT.metaDir, "params.lock");
    await mkdir(lockDir, { recursive: true });

    await expect(withParamsLock(projectDir, async () => "unreachable")).rejects.toMatchObject({
      error_code: "CONFLICT"
    });
    await expect(withParamsLock(projectDir, async () => "unreachable")).rejects.toBeInstanceOf(ScadForgeError);
  }, 20_000);

  it(`exposes PARAMS_LOCK_MAX_ATTEMPTS as a positive constant (kept in sync with the retry loop)`, () => {
    expect(PARAMS_LOCK_MAX_ATTEMPTS).toBeGreaterThan(0);
  });

  it("rapid sequential updates to the SAME key never deadlock -- the lock is fully released after each call", async () => {
    for (let i = 0; i < 25; i++) {
      await mergeParamsAtomic(projectDir, { size: i }, persistToDisk);
    }
    expect((await readRootParams()).size).toBe(24);
  });

  it("a persist callback that throws still releases the lock (no permanent wedge)", async () => {
    await expect(
      mergeParamsAtomic(projectDir, { x: 1 }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow();

    // The lock was released -- a subsequent call succeeds rather than hanging
    // or timing out into CONFLICT.
    const result = await mergeParamsAtomic(projectDir, { y: 2 }, persistToDisk);
    expect(result).toEqual({ y: 2 });
  });
});
