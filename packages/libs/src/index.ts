// @scadforge/libs — vendored BOSL2/MCAD + the `library_lookup` index.
//
// Issue #19. Vendored sources live in `../vendor/{bosl2,mcad}` (see
// `../vendor/bosl2/PROVENANCE.md` / `../vendor/mcad/PROVENANCE.md` for pins
// and license notices). This module exposes:
//   - `lookup(query, options?)` — the runtime the agent's `library_lookup`
//     tool handler calls. Result entries match `LibrarySymbol` from
//     `@scadforge/scad-core` (the FROZEN Issue #13 contract) EXACTLY.
//   - `bosl2Path()` / `mcadPath()` — absolute paths so scad-core's OpenSCAD
//     runner (Issue #14) can mount these libraries into render containers.
//
// Index acquisition: COMMITTED, not built at install. `scripts/build-index.mjs`
// parses the vendored `.scad` sources into `../generated/index.json`, which is
// committed to the repo and re-generated (and re-committed) only when the
// vendored pins move. This keeps `lookup()` synchronous and dependency-light
// (no parser, no child process, just `fs.readFileSync` + `JSON.parse` on a
// cached read) for use inside a tool handler, and keeps results byte-for-byte
// reproducible across machines instead of depending on parsing at every
// fresh `pnpm install`.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LibraryName, LibrarySymbol } from "@scadforge/scad-core";
import { LIBRARY_NAMES } from "@scadforge/scad-core";

export const LIBS_PACKAGE_NAME = "@scadforge/libs";

// ─────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────

// Compiled output lives at `dist/index.js`; `vendor/` and `generated/` are
// siblings of `dist/` and `src/` at the package root, so `../` from either
// reaches them without a build-time copy step.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INDEX_PATH = join(PACKAGE_ROOT, "generated", "index.json");

/** Absolute path to the vendored BOSL2 checkout (pinned commit — see PROVENANCE.md). */
export function bosl2Path(): string {
  return join(PACKAGE_ROOT, "vendor", "bosl2");
}

/** Absolute path to the vendored MCAD checkout (pinned commit — see PROVENANCE.md). */
export function mcadPath(): string {
  return join(PACKAGE_ROOT, "vendor", "mcad");
}

/** Absolute path to each vendored library, keyed by {@link LibraryName}. */
export function libraryPath(library: LibraryName): string {
  switch (library) {
    case "BOSL2":
      return bosl2Path();
    case "MCAD":
      return mcadPath();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Typed errors
// ─────────────────────────────────────────────────────────────────────────

/** {@link LibraryLookupError} discriminants. */
export type LibraryLookupErrorCode = "INDEX_MISSING" | "INDEX_INVALID" | "INVALID_QUERY";

/**
 * Thrown by {@link lookup} / {@link loadIndexFromPath} instead of letting a
 * raw `fs`/`JSON` error escape, so a tool handler can branch on `.code`
 * without string-matching a message.
 */
export class LibraryLookupError extends Error {
  readonly code: LibraryLookupErrorCode;

  constructor(code: LibraryLookupErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LibraryLookupError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Index loading
// ─────────────────────────────────────────────────────────────────────────

let cachedIndex: LibrarySymbol[] | null = null;
let cachedIndexPath: string | null = null;

/**
 * Reads and parses the committed index at an arbitrary path. Exported
 * (rather than kept private) so tests can exercise the "index missing" /
 * "index invalid" typed-error paths directly, without needing to delete the
 * real committed artifact.
 */
export function loadIndexFromPath(path: string): LibrarySymbol[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (cause) {
    throw new LibraryLookupError(
      "INDEX_MISSING",
      `Library lookup index not found at ${path}. Run "pnpm --filter @scadforge/libs build:index" and commit the result.`,
      { cause }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new LibraryLookupError("INDEX_INVALID", `Library lookup index at ${path} is not valid JSON.`, { cause });
  }

  if (!Array.isArray(parsed)) {
    throw new LibraryLookupError("INDEX_INVALID", `Library lookup index at ${path} must be a JSON array of symbols.`);
  }

  return parsed as LibrarySymbol[];
}

/** The parsed committed index, read and cached on first use. */
function getIndex(): LibrarySymbol[] {
  if (cachedIndex && cachedIndexPath === DEFAULT_INDEX_PATH) return cachedIndex;
  cachedIndex = loadIndexFromPath(DEFAULT_INDEX_PATH);
  cachedIndexPath = DEFAULT_INDEX_PATH;
  return cachedIndex;
}

/** Per-library symbol counts in the committed index — for reporting, not part of the frozen contract. */
export function libraryIndexStats(): Record<LibraryName, number> {
  const stats = Object.fromEntries(LIBRARY_NAMES.map((name) => [name, 0])) as Record<LibraryName, number>;
  for (const symbol of getIndex()) {
    stats[symbol.library] = (stats[symbol.library] ?? 0) + 1;
  }
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────
// lookup()
// ─────────────────────────────────────────────────────────────────────────

/** Options accepted by {@link lookup}, mirroring `LibraryLookupInput` minus `query`. */
export interface LookupOptions {
  /** Restrict the search to one library. */
  library?: LibraryName;
  /** Maximum number of matches to return. Defaults to 5; clamped to [1, 50]. */
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter(Boolean);
}

/**
 * Scores one symbol against the tokenized query. Higher is better; 0 means
 * "no match" and such entries are dropped before the result is truncated to
 * `limit`, so an unmatched query legitimately returns an empty array rather
 * than the whole index.
 *
 * The symbol's own name is tokenized the same way as the query (splitting
 * `threaded_rod` into `["threaded", "rod"]`) and scored on TWO fractions —
 * "how much of the symbol's name did the query cover" and "how much of the
 * query did the symbol's name cover" — rather than raw substring matching.
 * That is what ranks `threaded_rod` above a shorter, unrelated `rod` symbol
 * for the query "threaded rod": `rod` matches only one of the query's two
 * tokens, `threaded_rod` matches both. Substring/summary/signature checks
 * layer in afterwards as smaller tie-breaking bonuses, so compound or
 * camelCase names that don't tokenize apart still get partial credit.
 */
function score(symbol: LibrarySymbol, tokens: string[]): number {
  const nameLower = symbol.name.toLowerCase();
  const nameTokens = tokenize(symbol.name);
  const summaryLower = symbol.summary.toLowerCase();
  const signatureLower = symbol.signature.toLowerCase();
  const libraryLower = symbol.library.toLowerCase();

  const exactMatches = new Set(tokens.filter((t) => nameTokens.includes(t)));

  let total = 0;
  if (nameTokens.length > 0) total += (exactMatches.size / nameTokens.length) * 100;
  if (tokens.length > 0) total += (exactMatches.size / tokens.length) * 100;

  for (const token of tokens) {
    if (exactMatches.has(token)) continue;
    if (token === libraryLower) {
      total += 3; // "BOSL2 screw_hole" — library-name token is a hint, not noise.
      continue;
    }
    if (nameLower.includes(token)) total += 15; // compound/camelCase fallback, below any exact token match
    if (summaryLower.includes(token)) total += 4;
    if (signatureLower.includes(token)) total += 2;
  }
  return total;
}

/**
 * Queries the pre-built BOSL2/MCAD index. Synchronous — safe to call
 * directly from a tool handler. Result entries are {@link LibrarySymbol}
 * (scad-core's FROZEN contract) exactly, so they can be spread straight into
 * `library_lookup`'s result envelope.
 *
 * @throws {LibraryLookupError} `INVALID_QUERY` for an empty/whitespace-only
 *   query; `INDEX_MISSING` / `INDEX_INVALID` if the committed index cannot be
 *   loaded (see {@link loadIndexFromPath}).
 */
export function lookup(query: string, options: LookupOptions = {}): LibrarySymbol[] {
  if (query.trim() === "") {
    throw new LibraryLookupError("INVALID_QUERY", "library_lookup query must be a non-empty string.");
  }

  const limit = Math.max(1, Math.min(MAX_LIMIT, options.limit ?? DEFAULT_LIMIT));
  const tokens = tokenize(query);

  const pool = options.library ? getIndex().filter((s) => s.library === options.library) : getIndex();

  return pool
    .map((symbol) => ({ symbol, points: score(symbol, tokens) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      // Deterministic tie-break so repeat queries return a stable order.
      if (a.symbol.library !== b.symbol.library) return a.symbol.library.localeCompare(b.symbol.library);
      if (a.symbol.file !== b.symbol.file) return a.symbol.file.localeCompare(b.symbol.file);
      return a.symbol.name.localeCompare(b.symbol.name);
    })
    .slice(0, limit)
    .map((entry) => entry.symbol);
}
