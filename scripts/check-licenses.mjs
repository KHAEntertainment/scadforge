#!/usr/bin/env node
/**
 * License gate for the GPL-free zone.
 *
 * PROJECT_CONTEXT.md / CLAUDE.md hard rule 1: `packages/protocol`,
 * `packages/scad-core`, `packages/agent`, `packages/mcp-server` must stay
 * GPL-free (Apache-2.0 headers, no GPL/AGPL deps in their dependency
 * tree). This script walks the full dependency tree of each of those
 * packages (via `pnpm list --json --prod=false --depth Infinity`) and
 * fails if any dependency's declared license is GPL/AGPL-family.
 *
 * Usage:
 *   node scripts/check-licenses.mjs              # run the real gate
 *   node scripts/check-licenses.mjs --self-test   # prove the gate detects
 *                                                  # a GPL violation, using
 *                                                  # a temporary injected
 *                                                  # fixture (never a
 *                                                  # committed dependency)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(__dirname, "..");

// The GPL-free enforcement zone (PROJECT_CONTEXT.md license boundary).
const ENFORCED_PACKAGES = [
  "packages/protocol",
  "packages/scad-core",
  "packages/agent",
  "packages/mcp-server"
];

// Any license string containing one of these (case-insensitive) is
// considered a violation. Matches common SPDX forms: GPL-2.0, GPL-3.0,
// GPL-3.0-or-later, AGPL-3.0-only, "GNU General Public License", etc.
const FORBIDDEN_PATTERNS = [/\bA?GPL\b/i, /\bA?GPL[- ]?\d/i, /general public license/i];

/**
 * @param {string} licenseField Raw `license` value from a package.json
 *   (string form) or an entry from a `licenses` array — may be missing,
 *   malformed, or an object per older npm conventions.
 */
function isForbiddenLicense(licenseField) {
  if (licenseField == null) return false;
  let text;
  if (typeof licenseField === "string") {
    text = licenseField;
  } else if (typeof licenseField === "object") {
    // Malformed / legacy shape: { type: "GPL-3.0" } or similar.
    text = licenseField.type ?? JSON.stringify(licenseField);
  } else {
    text = String(licenseField);
  }
  return FORBIDDEN_PATTERNS.some((re) => re.test(text));
}

// Dependency buckets `pnpm list --json` nests a project/dependency node
// under. `unsavedDependencies` covers pnpm reporting hoisted/linked
// tooling that shows up without a matching declared range; included so a
// GPL package hiding there is not missed.
const DEP_BUCKET_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "unsavedDependencies"];

/**
 * Recursively collects { name, version, path } for every dependency node
 * in a `pnpm list --json` (project or dependency) tree. Each node's
 * `path` — the resolved on-disk install location pnpm itself reports —
 * is carried through so callers can read that exact package's
 * package.json directly, instead of re-deriving a store path from the
 * name/version (which breaks for `link:`/`workspace:`-protocol deps
 * whose "version" is not a plain semver).
 * @param {any} node
 * @param {Map<string, { name: string, version: string, path?: string }>} out
 */
function collectDeps(node, out) {
  if (!node || typeof node !== "object") return;
  for (const key of DEP_BUCKET_KEYS) {
    const bucket = node[key];
    if (!bucket || typeof bucket !== "object") continue;
    for (const [name, info] of Object.entries(bucket)) {
      const version = info?.version ?? "unknown";
      const id = `${name}@${version}`;
      if (!out.has(id)) {
        out.set(id, { name, version, path: info?.path });
        collectDeps(info, out);
      }
    }
  }
}

/**
 * Reads a dependency's own package.json `license` field to get its real
 * declared license (`pnpm list --json` does not include the license
 * field itself). Prefers the exact on-disk `path` pnpm reported for this
 * dependency; falls back to a best-effort node_modules lookup only when
 * that path is missing.
 * @param {string} name
 * @param {string} version
 * @param {string | undefined} installedPath
 * @returns {unknown} the license field, or undefined if it cannot be
 *   determined (missing package.json, unreadable file, malformed JSON).
 */
function readInstalledLicense(name, version, installedPath) {
  const candidates = [
    installedPath ? join(installedPath, "package.json") : undefined,
    join(repoRoot, "node_modules", ".pnpm", `${name.replace("/", "+")}@${version}`, "node_modules", name, "package.json"),
    join(repoRoot, "node_modules", name, "package.json")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, "utf8");
      const pkg = JSON.parse(raw);
      return pkg.license ?? pkg.licenses;
    } catch {
      // Missing/unreadable/malformed package.json for this dependency —
      // treat as "license unknown", not a crash. Counterexample-covered.
      continue;
    }
  }
  return undefined;
}

/**
 * Picks the workspace-project entry matching `absDir` out of a `pnpm list
 * --json` result. Workspace-aware `pnpm list` returns one entry per
 * project regardless of `cwd`, so the caller must not assume `roots[0]`
 * (or "merge every root") is the package being checked. Falls back to
 * `roots[0]` only if no entry's `path` matches (e.g. a non-workspace
 * single-project result).
 * @param {any[]} roots
 * @param {string} absDir
 */
function selectOwnRoot(roots, absDir) {
  return roots.find((r) => r && typeof r.path === "string" && join(r.path) === join(absDir)) ?? roots[0];
}

/**
 * @param {string} pkgDir Path relative to repo root, e.g. "packages/agent"
 * @returns {{ ok: boolean, violations: Array<{ name: string, version: string, license: unknown }>, error?: string }}
 */
function checkPackage(pkgDir) {
  const absDir = join(repoRoot, pkgDir);
  const pkgJsonPath = join(absDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return { ok: false, violations: [], error: `missing package.json at ${pkgDir}` };
  }

  let json;
  try {
    const raw = execFileSync(
      "pnpm",
      ["list", "--json", "--prod=false", "--depth", "Infinity"],
      { cwd: absDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, violations: [], error: `pnpm list failed for ${pkgDir}: ${err.message}` };
  }

  // IMPORTANT: inside a pnpm workspace, `pnpm list` returns an array with
  // one entry per workspace project (not just the one at `cwd`), even
  // when invoked from a package subdirectory. Select only the entry for
  // *this* package by matching its resolved `path` — otherwise a GPL dep
  // declared in a sibling package would be misattributed here, and a
  // real violation local to this package could be masked by scanning
  // everything at once instead of this project's own tree.
  const roots = Array.isArray(json) ? json : [json];
  const ownRoot = selectOwnRoot(roots, absDir);

  const deps = new Map();
  collectDeps(ownRoot, deps);

  if (deps.size === 0) {
    // No dependencies at all is a valid, clean state — not a violation.
    return { ok: true, violations: [] };
  }

  const violations = [];
  for (const { name, version, path: depPath } of deps.values()) {
    const license = readInstalledLicense(name, version, depPath);
    if (isForbiddenLicense(license)) {
      violations.push({ name, version, license });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Issue #31 AC: "no GPL import escapes apps/web/src/wasm/**". The GPL zone
 * (openscad-wasm glue, BOSL2-for-wasm bundling) is only ever a licensing
 * problem if it reaches one of the four GPL-free-enforced packages above —
 * source in `apps/web` itself is already GPL-3.0-or-later (see its
 * package.json), so this check's job is narrowly: do any of
 * `ENFORCED_PACKAGES`' own `.ts`/`.tsx` sources import the wasm zone or the
 * openscad-wasm glue directly? A plain recursive text scan is enough — no
 * TS parser needed — because a real import escaping the zone must appear as
 * a literal `from "..."`/`require("...")` specifier somewhere in the file.
 */
const WASM_ZONE_IMPORT_PATTERN = /(?:from|require\()\s*["'][^"']*(?:apps\/web\/src\/wasm|openscad-wasm|openscad\.wasm)[^"']*["']/;

/** @param {string} dir @param {string[]} out @returns {string[]} */
function collectSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** @returns {{ ok: boolean, violations: string[] }} */
function checkNoWasmZoneEscape() {
  const violations = [];
  for (const pkgDir of ENFORCED_PACKAGES) {
    const files = collectSourceFiles(join(repoRoot, pkgDir));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (WASM_ZONE_IMPORT_PATTERN.test(text)) {
        violations.push(file.slice(repoRoot.length + 1));
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function runGate() {
  let anyFailure = false;
  const report = [];

  for (const pkgDir of ENFORCED_PACKAGES) {
    const result = checkPackage(pkgDir);
    if (result.error) {
      anyFailure = true;
      report.push(`FAIL ${pkgDir}: ${result.error}`);
      continue;
    }
    if (!result.ok) {
      anyFailure = true;
      report.push(`FAIL ${pkgDir}: forbidden license(s) found —`);
      for (const v of result.violations) {
        report.push(`  - ${v.name}@${v.version}: ${JSON.stringify(v.license)}`);
      }
    } else {
      report.push(`OK   ${pkgDir}: no GPL/AGPL dependencies detected`);
    }
  }

  const escapeResult = checkNoWasmZoneEscape();
  if (!escapeResult.ok) {
    anyFailure = true;
    report.push("FAIL wasm-zone-escape: GPL wasm-zone import found outside apps/web/src/wasm/** —");
    for (const file of escapeResult.violations) {
      report.push(`  - ${file}`);
    }
  } else {
    report.push("OK   wasm-zone-escape: no GPL-free package imports apps/web/src/wasm/** or openscad-wasm");
  }

  console.log(report.join("\n"));
  if (anyFailure) {
    console.error("\nlicense-gate: FAILED — GPL/AGPL dependency found in a GPL-free package.");
    process.exit(1);
  }
  console.log("\nlicense-gate: PASSED");
  process.exit(0);
}

/**
 * Self-test mode: proves the gate actually detects a violation by
 * injecting a temporary fake GPL-licensed "dependency" package into a
 * scratch copy of node_modules for one enforced package, running the
 * license check logic directly against it (bypassing `pnpm list`, which
 * would require a real install), and asserting it is caught. Nothing is
 * written to the committed tree; all fixtures are created under a
 * tmpdir and removed afterwards, even on failure.
 */
function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "scadforge-license-gate-"));
  let passed = false;
  try {
    // Fixture 1: a clean dependency (written to disk to prove the on-disk
    // read path treats a normal MIT package.json as not-forbidden).
    writeFileSync(
      join(scratch, "left-pad-package.json"),
      JSON.stringify({ name: "left-pad", version: "1.3.0", license: "MIT" })
    );

    // Fixture 2: an injected GPL dependency, written to disk the same way
    // — proves the on-disk read path flags a real GPL package.json.
    writeFileSync(
      join(scratch, "gpl-fixture.json"),
      JSON.stringify({ name: "some-gpl-lib", version: "1.0.0", license: "GPL-3.0-or-later" })
    );

    // Fixture 3: a transitive GPL dependency, nested under a clean parent
    // — MUST be flagged (proves the recursive walk reaches transitives).
    const transitiveTree = {
      dependencies: {
        "clean-lib": {
          version: "2.0.0",
          dependencies: {
            "agpl-transitive": { version: "3.1.0" }
          }
        }
      }
    };

    // Fixture 4: a malformed license field (object shape instead of
    // string) that still resolves to a GPL family — MUST be flagged, not
    // crash.
    const malformedLicense = { type: "AGPL-3.0-only", url: "https://example.invalid" };

    // Fixture 5: missing / empty deps — MUST be treated as clean (ok=true),
    // not an error.
    const emptyTree = {};

    // Fixture 6: a `link:`-protocol dependency (the real shape pnpm
    // reports for a workspace-local/linked fixture, whose "version" is
    // not a plain semver) whose on-disk package.json is GPL-licensed —
    // MUST be flagged via its reported `path`, not a derived store path
    // (regression coverage for the bug this self-test originally missed:
    // the gate silently passed against a real injected GPL dependency
    // until `path`-based resolution replaced name/version path-guessing).
    const linkDepDir = join(scratch, "linked-gpl-dep");
    mkdirSync(linkDepDir, { recursive: true });
    writeFileSync(
      join(linkDepDir, "package.json"),
      JSON.stringify({ name: "linked-gpl-dep", version: "1.0.0", license: "GPL-3.0-or-later" })
    );
    const linkProtocolTree = {
      path: join(scratch, "consuming-package"),
      devDependencies: {
        "linked-gpl-dep": {
          version: "link:../linked-gpl-dep",
          path: linkDepDir
        }
      }
    };

    // Fixture 7: a workspace-wide `pnpm list` array (as real pnpm returns
    // even when invoked from a package subdirectory) with the checked
    // package NOT first — MUST select the matching entry by `path`, not
    // just merge/assume roots[0] (the other half of the same regression).
    const workspaceArray = [
      { path: join(scratch, "other-package"), devDependencies: { "unrelated-lib": { version: "1.0.0" } } },
      linkProtocolTree
    ];

    // --- assertions ---
    const results = [];

    // (a) clean license string is not forbidden
    results.push(["clean MIT license not flagged", isForbiddenLicense("MIT") === false]);

    // (a2) the on-disk clean fixture round-trips as not-forbidden
    const cleanFixture = JSON.parse(readFileSync(join(scratch, "left-pad-package.json"), "utf8"));
    results.push(["on-disk clean fixture not flagged", isForbiddenLicense(cleanFixture.license) === false]);

    // (a3) the on-disk GPL fixture round-trips as forbidden
    const gplFixture = JSON.parse(readFileSync(join(scratch, "gpl-fixture.json"), "utf8"));
    results.push(["on-disk GPL fixture flagged", isForbiddenLicense(gplFixture.license) === true]);

    // (b) direct GPL license string is forbidden
    results.push(["direct GPL-3.0-or-later flagged", isForbiddenLicense("GPL-3.0-or-later") === true]);

    // (c) AGPL variant is forbidden
    results.push(["AGPL-3.0-only flagged", isForbiddenLicense("AGPL-3.0-only") === true]);

    // (d) malformed object-shaped license still detected
    results.push(["malformed AGPL object flagged", isForbiddenLicense(malformedLicense) === true]);

    // (e) missing/undefined license is NOT treated as forbidden (unknown
    // license is a separate concern from a confirmed GPL violation) but
    // also must not throw.
    let missingThrew = false;
    let missingResult;
    try {
      missingResult = isForbiddenLicense(undefined);
    } catch {
      missingThrew = true;
    }
    results.push(["missing license does not throw", missingThrew === false]);
    results.push(["missing license not flagged as forbidden", missingResult === false]);

    // (f) recursive collectDeps reaches a transitive dependency
    const collected = new Map();
    collectDeps(transitiveTree, collected);
    results.push([
      "transitive dependency reached by collectDeps",
      collected.has("agpl-transitive@3.1.0")
    ]);

    // (f2) — regression coverage — selectOwnRoot picks the matching
    // project out of a multi-project workspace array by `path`, not
    // just roots[0].
    const ownRoot = selectOwnRoot(workspaceArray, join(scratch, "consuming-package"));
    results.push([
      "selectOwnRoot picks the matching workspace project",
      ownRoot === linkProtocolTree
    ]);

    // (f3) — regression coverage — a `link:`-protocol dependency (version
    // is not semver) is still resolved to its real on-disk license via
    // the `path` pnpm reported, end-to-end through collectDeps +
    // readInstalledLicense exactly as checkPackage uses them.
    const linkDeps = new Map();
    collectDeps(ownRoot, linkDeps);
    const linkedEntry = linkDeps.get("linked-gpl-dep@link:../linked-gpl-dep");
    const linkedLicense = linkedEntry
      ? readInstalledLicense(linkedEntry.name, linkedEntry.version, linkedEntry.path)
      : undefined;
    results.push([
      "link:-protocol GPL dependency resolved via reported path",
      linkedEntry !== undefined && isForbiddenLicense(linkedLicense) === true
    ]);

    // (g) empty tree collects zero deps without throwing (missing
    // package.json / empty deps counterexample)
    const emptyCollected = new Map();
    let emptyThrew = false;
    try {
      collectDeps(emptyTree, emptyCollected);
    } catch {
      emptyThrew = true;
    }
    results.push(["empty dependency tree does not throw", emptyThrew === false]);
    results.push(["empty dependency tree collects nothing", emptyCollected.size === 0]);

    // (h) checkPackage on a missing package.json path reports a
    // structured error rather than throwing.
    const missingPkgResult = checkPackage("packages/__does-not-exist__");
    results.push([
      "missing package.json reported as structured error",
      missingPkgResult.ok === false && typeof missingPkgResult.error === "string"
    ]);

    // (i) — Issue #31 AC — wasm-zone-escape pattern flags a real import of
    // the GPL zone / openscad-wasm glue from an enforced package's source.
    results.push([
      "wasm-zone import pattern flags apps/web/src/wasm import",
      WASM_ZONE_IMPORT_PATTERN.test('import { x } from "../../../apps/web/src/wasm/index.js";')
    ]);
    results.push([
      "wasm-zone import pattern flags a direct openscad-wasm reference",
      WASM_ZONE_IMPORT_PATTERN.test('const mod = require("openscad-wasm");')
    ]);
    results.push([
      "wasm-zone import pattern does not flag an unrelated import",
      WASM_ZONE_IMPORT_PATTERN.test('import { z } from "@scadforge/scad-core";') === false
    ]);

    // (j) — a real scan of this repo's actual ENFORCED_PACKAGES sources
    // finds zero escapes today (regression guard: this assertion is the one
    // that would fail if a future PR actually introduced the violation).
    const realScanResult = checkNoWasmZoneEscape();
    results.push(["current ENFORCED_PACKAGES sources have no wasm-zone escape", realScanResult.ok === true]);

    // (k) collectSourceFiles on a nonexistent directory returns [] instead
    // of throwing (counterexample: an enforced package dir that doesn't exist).
    let collectThrew = false;
    let collectResult;
    try {
      collectResult = collectSourceFiles(join(scratch, "does-not-exist"), []);
    } catch {
      collectThrew = true;
    }
    results.push(["collectSourceFiles on a missing directory does not throw", collectThrew === false]);
    results.push(["collectSourceFiles on a missing directory returns empty", Array.isArray(collectResult) && collectResult.length === 0]);

    console.log("License-gate self-test results:");
    let allPassed = true;
    for (const [label, ok] of results) {
      console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
      if (!ok) allPassed = false;
    }

    passed = allPassed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (!passed) {
    console.error("\nlicense-gate self-test: FAILED — detection logic did not behave as expected.");
    process.exit(1);
  }
  console.log("\nlicense-gate self-test: PASSED — GPL/AGPL detection confirmed on injected fixtures.");
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  runSelfTest();
} else {
  runGate();
}
