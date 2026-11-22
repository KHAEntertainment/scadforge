// SPDX-License-Identifier: Apache-2.0
//
// Regression guard (Issue #109). Convention this repo relies on: every
// `withRecoveredProject` callback, and every helper whose name ends in
// `Locked` (this codebase's own naming convention for "runs inside the
// recovery boundary" -- see `scad-core-impl.ts`'s `submitEditorCommand`/
// `updateSource` NOTE comments and `runtime.ts`'s `readScadLocked`/
// `readParamsLocked` doc comments), must throw ONLY a `ScadForgeError`, never
// apps/server's `RouteError` (directly, or via `toRouteError`). scad-core's
// `withRecoveredProject` wraps the whole callback in its own `withTypedError`,
// which preserves the code of an already-`ScadForgeError` but flattens
// anything else -- including a `RouteError`, a class scad-core has never
// heard of -- to a generic `INTERNAL_ERROR`, silently losing the intended
// error code (Issue #109's original bug: `updateSource`'s in-lock CONFLICT
// throw surfaced as a 500).
//
// This is a static/textual scan (a "grep check"), not a full parse: for every
// `withRecoveredProject(...)` call, it extracts the call's own argument span
// (which is the callback, whatever shape it takes) and for every
// function/arrow declaration named `*Locked`, it extracts the function body,
// then checks each span for `throw new RouteError(` or `toRouteError(`.
// Scoped to apps/server/src/services/**/*.ts (excluding tests) -- the only
// place that can introduce this bug, since `RouteError` is apps/server-only
// and scad-core itself cannot import it.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Finds the index of the `close` character matching the `open` character at
 * `openIndex`, skipping single/double-quoted string contents and `//`/`/*`
 * comments so a brace or paren inside a message's TEXT can never desync the
 * count. Backtick template literals are deliberately NOT skipped -- a
 * `${...}` hole inside one is real code (its braces must be counted), and
 * this codebase's own message text never contains a literal, unbalanced
 * brace or paren.
 */
function findMatchingClose(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
    } else if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++; // consume the trailing '/'
    } else {
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

interface Violation {
  file: string;
  line: number;
  where: string;
}

const VIOLATION_PATTERN = /\bthrow\s+new\s+RouteError\(|\btoRouteError\(/;

/** (i): every `withRecoveredProject(dir, callback)` call's own callback argument. */
function scanWithRecoveredProjectCallbacks(file: string, source: string, violations: Violation[]): void {
  const callRe = /withRecoveredProject\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = findMatchingClose(source, parenOpen, "(", ")");
    if (parenClose === -1) continue;
    const argsSpan = source.slice(parenOpen + 1, parenClose);
    if (VIOLATION_PATTERN.test(argsSpan)) {
      violations.push({ file, line: lineOf(source, parenOpen), where: "withRecoveredProject callback" });
    }
  }
}

/** (ii): every function/arrow declaration whose name ends in `Locked`, by convention run inside the boundary. */
function scanLockedFunctions(file: string, source: string, violations: Violation[]): void {
  const declRe = /(?:export\s+)?(?:async\s+)?function\s+(\w*Locked)\s*\(/g;
  const constRe = /const\s+(\w*Locked)\s*=\s*async\s*(?:\([^)]*\)|\w+)\s*=>/g;
  for (const re of [declRe, constRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const braceOpen = source.indexOf("{", m.index + m[0].length - 1);
      if (braceOpen === -1) continue;
      const braceClose = findMatchingClose(source, braceOpen, "{", "}");
      if (braceClose === -1) continue;
      const bodySpan = source.slice(braceOpen + 1, braceClose);
      if (VIOLATION_PATTERN.test(bodySpan)) {
        violations.push({ file, line: lineOf(source, m.index), where: `function ${m[1]}` });
      }
    }
  }
}

describe("caller-audit: RouteError never thrown inside the recovery boundary (Issue #109)", () => {
  it("no withRecoveredProject callback or *Locked helper under apps/server/src/services/** throws RouteError/toRouteError", async () => {
    const files = await listSourceFiles(SERVICES_DIR);
    const violations: Violation[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      scanWithRecoveredProjectCallbacks(file, source, violations);
      scanLockedFunctions(file, source, violations);
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
