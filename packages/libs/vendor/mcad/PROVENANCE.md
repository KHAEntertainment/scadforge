# MCAD — provenance

- **Upstream**: https://github.com/openscad/MCAD
- **Pinned commit**: `bd0a7ba3f042bfbced5ca1894b236cea08904e26` (`master`, fetched 2026-08-26)
- **License**: LGPL-2.1 (`LICENSE` in this directory, copied verbatim from the pinned commit's `lgpl-2.1.txt`)

## What's vendored

Every top-level `*.scad` file from the repo root at the pinned commit
(36 files), plus `LICENSE` and `README.md` (from `README.markdown`).

## What's excluded, and why

| Excluded | Reason |
| --- | --- |
| `bitmap/` (~48 KB) | Bitmap font assets. Verified no vendored `.scad` file references `bitmap/` at all — nothing in the vendored library surface loads it. |
| `*.py` (`__init__.py`, `openscad_utils.py`, `openscad_testing.py`, `test_mcad.py`, `test_docs.py`) | MCAD's own Python test harness; irrelevant to consuming the `.scad` library from OpenSCAD. |
| `.gitignore`, `TODO` | Repo housekeeping, not library content. |

MCAD predates BOSL2's structured doc-comment convention: most files carry
only a handful of loose `//` lines above a `module`/`function`, if any.

## Re-pinning

To move to a newer commit:

1. `git clone https://github.com/openscad/MCAD.git` and `git checkout <new-commit>`.
2. Replace every `*.scad` file and `LICENSE`/`README.md` in this directory with the new checkout's top-level versions (same exclusion list above).
3. Update the pinned commit above and in `packages/libs/README.md`.
4. Re-run `pnpm --filter @scadforge/libs build:index` and commit the regenerated `packages/libs/generated/index.json`.
5. Update the `libraryIndexStats()` regression-guard counts in `packages/libs/src/index.test.ts` if the symbol counts changed.
