#!/usr/bin/env node
/**
 * License gate end-to-end injection check (Issue #10).
 *
 * The unit-level `--self-test` proves detection logic against hand-built
 * fixtures, but it bypasses the real integration path: `pnpm install` →
 * `pnpm list --json` → gate. A pnpm JSON-schema change could regress that
 * path silently. This script proves the REAL gate fails (exit 1) on a REAL
 * injected GPL dependency, using the same manual procedure QA used in
 * PR #8, then reverts the tree byte-for-byte:
 *
 *   1. create a scratch fixture package declaring `GPL-3.0-or-later`
 *   2. inject it as a `link:`-protocol devDependency of packages/agent
 *   3. `pnpm install --no-frozen-lockfile`
 *   4. run the real gate — MUST exit 1 and name the fixture
 *   5. restore packages/agent/package.json + pnpm-lock.yaml byte-for-byte,
 *      remove the fixture, and `pnpm install --frozen-lockfile` to return
 *      node_modules to the clean state (the following CI "License gate"
 *      step then re-proves the clean tree passes)
 *
 * Exits 0 only if the gate failed as expected AND the tree was restored.
 * Signal interruption (SIGKILL) mid-run can leave package.json/lockfile
 * dirty; recover locally with `git checkout -- packages/agent/package.json
 * pnpm-lock.yaml && pnpm install --frozen-lockfile`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

const TARGET_PKG_DIR = join(repoRoot, "packages/agent");
const FIXTURE_NAME = "gpl-e2e-fixture-dep";
const FIXTURE_PARENT = join(repoRoot, ".tmp-license-gate-fixture");
const FIXTURE_DIR = join(FIXTURE_PARENT, FIXTURE_NAME);

const pkgJsonPath = join(TARGET_PKG_DIR, "package.json");
const lockfilePath = join(repoRoot, "pnpm-lock.yaml");
const pkgBackup = readFileSync(pkgJsonPath, "utf8");
const lockBackup = readFileSync(lockfilePath, "utf8");

let failed = false;

try {
  // 1. Scratch GPL fixture package.
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    join(FIXTURE_DIR, "package.json"),
    JSON.stringify({ name: FIXTURE_NAME, version: "1.0.0", license: "GPL-3.0-or-later" }, null, 2) + "\n"
  );
  writeFileSync(join(FIXTURE_DIR, "index.js"), "module.exports = {};\n");

  // 2. Inject as a `link:`-protocol devDependency (the shape QA used in
  //    PR #8 — exercises the path-based license resolution that plain
  //    semver fixtures don't).
  const pkg = JSON.parse(pkgBackup);
  pkg.devDependencies = {
    ...(pkg.devDependencies ?? {}),
    [FIXTURE_NAME]: `link:../../.tmp-license-gate-fixture/${FIXTURE_NAME}`
  };
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

  // 3. Install the injected state.
  const install = spawnSync("pnpm", ["install", "--no-frozen-lockfile"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (install.status !== 0) {
    console.error("license-gate e2e: FAILED — pnpm install with injected fixture did not succeed.");
    failed = true;
  } else {
    // 4. Run the real gate — it MUST fail and name the fixture.
    const gate = spawnSync(process.execPath, [join(repoRoot, "scripts", "check-licenses.mjs")], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    const gateOut = `${gate.stdout ?? ""}\n${gate.stderr ?? ""}`;
    if (gate.status !== 1) {
      console.error(`license-gate e2e: FAILED — gate exited ${gate.status}, expected 1 with the injected GPL dep.\n${gateOut}`);
      failed = true;
    } else if (!gateOut.includes(FIXTURE_NAME)) {
      console.error(`license-gate e2e: FAILED — gate exited 1 but did not name ${FIXTURE_NAME}.\n${gateOut}`);
      failed = true;
    } else {
      console.log(`license-gate e2e: gate correctly exited 1 and named ${FIXTURE_NAME} via the real pnpm list path.`);
    }
  }
} finally {
  // 5. Revert byte-for-byte and restore node_modules to the clean state.
  writeFileSync(pkgJsonPath, pkgBackup);
  writeFileSync(lockfilePath, lockBackup);
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  const restore = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (restore.status !== 0) {
    console.error("license-gate e2e: FAILED — clean-tree reinstall did not succeed after revert.");
    failed = true;
  }
}

if (failed) {
  console.error("\nlicense-gate e2e: FAILED");
  process.exit(1);
}
console.log("\nlicense-gate e2e: PASSED — real pnpm list path detects an injected GPL dep, tree reverted clean.");
process.exit(0);
