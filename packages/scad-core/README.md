# @scadforge/scad-core

The OpenSCAD project model (SDP §11). Responsibilities:

- `src/types.ts` — frozen core domain types (project, snapshot, parameter
  set). Frozen once its contract-freeze issue merges; changes go through
  the Tech Lead (CLAUDE.md hard rule 2), not feature PRs.
- `params/` — Customizer parameter comment parsing
  (`// [min:max]`, `// [a, b, c]`, `/* [Section] */`).
- `store/` — filesystem project store (`.scadforge/` per project folder).
  No database (PROJECT_CONTEXT.md).
- `validate/` — mesh validation (manifold-3d integration).
- `runner/` — OpenSCAD CLI subprocess runner (server-authoritative render).

License: Apache-2.0 (GPL-free zone — see PROJECT_CONTEXT.md license boundary).
