// SPDX-License-Identifier: Apache-2.0
//
// Caller audit (Issue #73 / S3-B ticket B2 AC): proves the access-inventory
// migration is CLOSED, not just believed closed. A file that both (a) knows
// how to construct a root/history path (`rootModelPath`, `rootParamsPath`,
// `projectFilePath`, `snapshotDir`) AND (b) performs a raw filesystem write
// (`writeFile`/`rename`) is, by construction, capable of mutating the
// project's root/history state directly -- exactly what `withRecoveredProject`
// exists to be the ONLY path for. Every such file must be one of the
// allow-listed boundary modules below; anything else failing this test is a
// bypass, caught here rather than discovered later as a corruption/coherence
// bug.
//
// A file that only READS through these path helpers (e.g. staging an
// already-committed, immutable snapshot's own bytes for OpenSCAD --
// `apps/server/src/services/runtime.ts`'s `readSnapshotScad`/
// `stageSnapshotModel`) does not trip this check on its own: constructing a
// root/history path is not itself a hazard, only pairing that with a WRITE
// primitive in the same file is (see `store/paths.ts`'s own definitions,
// which construct these paths but never write through them, and every
// `runner/*` file, which never references a root/history path at all).
//
// This test is PROVED to actually catch a bypass -- not merely believed to
// -- in the PR body: a scratch commit adding a direct root-path write
// outside the allow-list was introduced, this test was run and observed to
// fail, then the scratch commit was reverted. See the PR description for
// that evidence.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/scad-core/src/store/` -> repo root. */
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

/** The four root/history path constructors this audit watches for. */
const PATH_HELPER_PATTERN = /\b(rootModelPath|rootParamsPath|projectFilePath|snapshotDir)\s*\(/;
/** The two raw write primitives that, paired with a path helper above, can mutate root/history state directly. */
const WRITE_PRIMITIVE_PATTERN = /\b(writeFile|rename)\s*\(/;

/**
 * Every module allowed to combine a root/history path helper with a raw
 * write -- because IT is the recovery boundary, or code that composes
 * directly against an already-open `LockedProject` ctx. Repo-relative,
 * forward-slash paths. Adding an entry here is the audit failing loudly
 * enough to demand a deliberate decision, not a silent widening.
 */
const ALLOW_LISTED_BOUNDARY_MODULES = [
  "packages/scad-core/src/store/store.ts",
  "packages/scad-core/src/editor/sidecar.ts", // Issue #87 / S3-B ticket B3: readSidecarLocked/writeSidecarLocked/etc. all take an already-open `LockedProject` ctx and never reacquire the lock.
  "apps/server/src/services/runtime.ts",
  "apps/server/src/services/scad-core-impl.ts",
  "apps/server/src/services/agent-scad-core.ts"
];

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("caller audit: every root/history path-write combination lives in an allow-listed boundary module (Issue #73)", () => {
  it("apps/server/src and packages/scad-core/src contain no bypass of the recovery boundary", async () => {
    const scanRoots = [join(REPO_ROOT, "apps", "server", "src"), join(REPO_ROOT, "packages", "scad-core", "src")];
    const files = (await Promise.all(scanRoots.map(collectTsFiles))).flat();
    expect(files.length).toBeGreaterThan(10); // sanity: the scan actually found the source tree, not an empty/wrong path

    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (PATH_HELPER_PATTERN.test(content) && WRITE_PRIMITIVE_PATTERN.test(content)) {
        const rel = relative(REPO_ROOT, file).split("\\").join("/");
        if (!ALLOW_LISTED_BOUNDARY_MODULES.includes(rel)) offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("every allow-listed module still exists and still combines a path helper with a write primitive -- the allow-list is not stale", async () => {
    for (const rel of ALLOW_LISTED_BOUNDARY_MODULES) {
      const content = await readFile(join(REPO_ROOT, rel), "utf8");
      expect(PATH_HELPER_PATTERN.test(content), `${rel} no longer uses a root/history path helper -- remove it from the allow-list`).toBe(true);
      expect(WRITE_PRIMITIVE_PATTERN.test(content), `${rel} no longer writes directly -- remove it from the allow-list`).toBe(true);
    }
  });
});
