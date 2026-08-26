# BOSL2 — provenance

- **Upstream**: https://github.com/BelfrySCAD/BOSL2
- **Pinned commit**: `f930be2bcaa32c09a30a57106e7ee97d9d12d987` (`master`, fetched 2026-08-26)
- **License**: BSD-2-Clause (`LICENSE` in this directory, copied verbatim from the pinned commit)

## What's vendored

Every top-level `*.scad` file from the repo root at the pinned commit
(56 files), plus `LICENSE` and `README.md`.

## What's excluded, and why

| Excluded | Reason |
| --- | --- |
| `tests/` | BOSL2's own test suite; not needed to `include`/`use` the library or to build the lookup index. |
| `examples/`, `tutorials/` | Documentation/demo `.scad` files, not part of the includable library surface. |
| `images/` (~6 MB) | Doc-comment illustration assets referenced only from Markdown-rendered docs (`![...](images/...)` inside `//` doc comments) — never loaded by OpenSCAD at parse/render time. Verified by checking that every `images/` reference in the vendored sources appears inside a `//` comment line, not executable code. |
| `resources/` | DocGen tooling assets (a Lua filter, a docs stylesheet) for BOSL2's own documentation generator; unrelated to using the library. |
| `scripts/`, `.github/` | BOSL2's own CI/build tooling. |

This keeps the vendored payload at the `.scad` source files that
`include <BOSL2/...>` / `use <BOSL2/...>` actually resolve, without the
maintainers' documentation-generation machinery.

## Re-pinning

To move to a newer commit:

1. `git clone https://github.com/BelfrySCAD/BOSL2.git` and `git checkout <new-commit>`.
2. Replace every `*.scad` file, `LICENSE`, and `README.md` in this directory with the new checkout's top-level versions (same exclusion list above).
3. Update the pinned commit above and in `packages/libs/README.md`.
4. Re-run `pnpm --filter @scadforge/libs build:index` and commit the regenerated `packages/libs/generated/index.json`.
5. Update the `libraryIndexStats()` regression-guard counts in `packages/libs/src/index.test.ts` if the symbol counts changed.
