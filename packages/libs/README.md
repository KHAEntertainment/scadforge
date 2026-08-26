# @scadforge/libs

Vendored BOSL2/MCAD OpenSCAD libraries plus a lookup index (SDP §11),
consumed by the agent's `library_lookup` tool.

This package is not part of the GPL-free enforcement zone (see
PROJECT_CONTEXT.md license boundary — only `packages/{protocol,scad-core,
agent,mcp-server}` are required to stay GPL-free); it carries the repo's
default GPL-3.0-or-later license.

License: GPL-3.0-or-later.

## Vendored libraries

| Library | Pinned commit | License | Provenance |
| --- | --- | --- | --- |
| [BOSL2](https://github.com/BelfrySCAD/BOSL2) | `f930be2bcaa32c09a30a57106e7ee97d9d12d987` | BSD-2-Clause | `vendor/bosl2/PROVENANCE.md` |
| [MCAD](https://github.com/openscad/MCAD) | `bd0a7ba3f042bfbced5ca1894b236cea08904e26` | LGPL-2.1 | `vendor/mcad/PROVENANCE.md` |

Both licenses are carried verbatim as `vendor/{bosl2,mcad}/LICENSE`. Each
`PROVENANCE.md` documents exactly what was excluded from the vendored
payload (test suites, doc-illustration images, the upstream test harness)
and why, plus the re-pinning procedure.

## Runtime API

```ts
import { lookup, bosl2Path, mcadPath } from "@scadforge/libs";

const matches = lookup("BOSL2 screw_hole");
// LibrarySymbol[] — the exact shape frozen in @scadforge/scad-core's
// src/types.ts (Issue #13): { library, name, kind, signature, file,
// summary, examples, include }

bosl2Path(); // absolute path to the vendored BOSL2 checkout
mcadPath();  // absolute path to the vendored MCAD checkout
```

- `lookup(query, { library?, limit? })` is **synchronous** and
  **dependency-light** (`node:fs` + `JSON.parse` only) — safe to call
  directly from a tool handler.
- Throws `LibraryLookupError` (a typed error with a `.code` of
  `INVALID_QUERY` / `INDEX_MISSING` / `INDEX_INVALID`) instead of a raw
  `fs`/`JSON` error. A query with no matches is not an error — it returns
  `[]`.
- `bosl2Path()` / `mcadPath()` (and the by-name `libraryPath(library)`) give
  scad-core's OpenSCAD runner (Issue #14) absolute paths to mount into
  render containers.

## Index acquisition: committed, not built at install

`scripts/build-index.mjs` parses the vendored `.scad` sources into
`generated/index.json`, which is **committed to the repo** rather than
generated on every `pnpm install`. Rationale:

- **Determinism**: the same index ships to every machine and CI run; a
  parse-at-install step would re-derive it (slower, and one more thing that
  can silently drift if the parser changes).
- **Dependency-light runtime**: `lookup()` becomes a synchronous
  `readFileSync` + `JSON.parse` with no parser, in-process regex work, or
  child process on the tool-handler hot path.
- **Reviewable diffs**: index changes land as a normal file diff in the PR
  that moved the vendored pins, instead of being invisible build output.

Re-run `pnpm --filter @scadforge/libs build:index` and commit the result
whenever the vendored sources are re-pinned (see each library's
`PROVENANCE.md` "Re-pinning" section).

### Index stats (current pins)

- **1,175 symbols total**
- BOSL2: 972 (from 56 vendored `.scad` files)
- MCAD: 203 (from 36 vendored `.scad` files, excluding `test_*` demo modules)

## Parsing approach

- **BOSL2** ships a structured DocGen doc-comment convention — a run of
  `//`-prefixed lines opening with `// Module: name()` / `// Function: name()`
  / `// Function&Module: name()` / `// Constant: name`, with tagged
  subsections (`Synopsis`, `Usage`, `Description`, `Example`, ...). The
  parser reads that structure directly (see `scripts/build-index.mjs`'s BOSL2
  section for the exact grammar it handles, including repeated `Usage`/
  `Example` tags for multiple call forms).
- **MCAD** predates any doc-comment convention: the parser picks up
  column-0 (non-indented) `module name(...)` / `function name(...)`
  declarations, using any immediately-preceding `//` comment lines as the
  summary when present, and skips `test_*` demo modules.

## Tests

`src/index.test.ts` covers 12 representative queries (including one MCAD
`library` filter) plus counterexamples: empty/whitespace query, no-match
query, a huge (~35,000-char) query, limit clamping at both ends, and typed
`INDEX_MISSING`/`INDEX_INVALID` errors via `loadIndexFromPath` against a
nonexistent path and malformed temp files.
