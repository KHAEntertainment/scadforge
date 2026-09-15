// SPDX-License-Identifier: Apache-2.0
//
// S3-B ticket B6, carried B4 delta QA (PR #96 review): proves
// `recoverPendingClaimsLocked` never reads a terminal claim's own file
// during recovery, only the pending-marker set. Kept in its OWN file,
// separate from `transaction.test.ts`'s other 30+ tests -- Node's
// `fs/promises` builtin exports are not configurable, so proving this needs
// a full-module `vi.mock` (a plain `vi.spyOn` throws "Cannot redefine
// property"), and that mock's call-through wrapper should not shadow every
// other test in the suite for no reason.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectManifest } from "@scadforge/protocol";
import { canonicalJson } from "../editor/canonical.js";
import { EMPTY_SIDECAR } from "../editor/sidecar-empty.js";
import { historyDir, metaDir, projectFilePath, rootModelPath, rootParamsPath, sidecarPath } from "./paths.js";
import { withRecoveredProject } from "./recovered.js";
import type { LockedProject } from "./recovered.js";
import { lookupClaimLocked, recordClaimRejectedLocked, reserveClaimLocked } from "./claims.js";
import { recoverPendingClaimsLocked } from "./transaction.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Wraps (never replaces) the real implementation, so every other call in
  // this file behaves exactly as it would unmocked -- only `.mock.calls`
  // gives this test a call-count seam.
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const PROVIDER = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-pending-sweep-test-"));
  await mkdir(metaDir(projectDir), { recursive: true });
  await mkdir(historyDir(projectDir), { recursive: true });
  const manifest: ProjectManifest = {
    schema_version: 1,
    id: "hinged-box",
    name: "Test",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    openscad_image: "openscad/openscad@sha256:test",
    openscad_version: "2026.01.19",
    provider: PROVIDER,
    head: null,
    editor_store_version: 1
  };
  await writeFile(projectFilePath(projectDir), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(rootModelPath(projectDir), "cube(1);\n", "utf8");
  await writeFile(rootParamsPath(projectDir), JSON.stringify({ fileFormatVersion: "1", parameterSets: { current: {} } }, null, 2), "utf8");
  await writeFile(sidecarPath(projectDir), canonicalJson(EMPTY_SIDECAR), "utf8");
});

afterEach(async () => {
  vi.mocked(readFile).mockClear(); // keep the call-through wrapper; only forget this test's calls
  await rm(projectDir, { recursive: true, force: true });
});

function withCtx<T>(fn: (ctx: LockedProject) => Promise<T>): Promise<T> {
  return withRecoveredProject(projectDir, fn);
}

describe("recoverPendingClaimsLocked proportionality (S3-B ticket B6, carried B4 delta QA)", () => {
  it("reads zero terminal-claim files when many claims are already terminal", async () => {
    await withCtx(async (ctx) => {
      // 200 claims resolved straight to a terminal state, plus ONE genuinely
      // orphaned pending claim -- the sweep must resolve the one pending
      // claim without ever reading any of the 200 terminal claim files. The
      // OLD (pre-B6) sweep listed and read every file under
      // `editor-operations/`, so this is exactly the regression it guards.
      const terminalIds: string[] = [];
      for (let i = 0; i < 200; i++) {
        const id = `terminal-op-${i}`;
        terminalIds.push(id);
        await reserveClaimLocked(ctx, id, `digest-${i}`, {});
        await recordClaimRejectedLocked(ctx, id, { error_code: "VALIDATION_FAILED", message: "fixture rejection" });
      }
      await reserveClaimLocked(ctx, "orphan-op", "digest-orphan", {});

      vi.mocked(readFile).mockClear(); // only count reads from the sweep itself, not the setup above

      await recoverPendingClaimsLocked(ctx);

      const readTerminalPaths = vi
        .mocked(readFile)
        .mock.calls.map((call) => String(call[0]))
        .filter((path) => terminalIds.some((id) => path.endsWith(`${id}.json`)));
      expect(readTerminalPaths).toEqual([]);

      expect(await lookupClaimLocked(ctx, "orphan-op")).toMatchObject({ kind: "definitely_not_committed", reason: "aborted" });
    });
  }, 20000); // 200 sequential reserve+reject fs round trips genuinely exceed vitest's 5s default under real parallel-suite CPU contention (observed flake under `pnpm -r test`'s default parallelism) -- same reason several store.test.ts/fault-matrix.test.ts cases already carry an explicit timeout, not a routed-around flake.
});
