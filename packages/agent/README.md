# @scadforge/agent

Claude Agent SDK integration (SDP §11), behind a `ModelProvider` seam so the
underlying model backend can be swapped. Responsibilities:

- `src/tools/contract.ts` — frozen tool-call contract for the 7 shared
  agent tools (`read_project, write_scad, set_params, render_views,
  validate_mesh, export, library_lookup`). Frozen once its contract-freeze
  issue merges; changes go through the Tech Lead (CLAUDE.md hard rule 2),
  not feature PRs.
- `prompts/` — system/task prompts for the agent loop.
- `provider/` — `ModelProvider` implementations.

Enforces the agent loop cap: max 2 autonomous self-correction passes per
user turn (`SCADFORGE_MAX_PASSES`), stopping early on green validation.

License: Apache-2.0 (GPL-free zone — see PROJECT_CONTEXT.md license boundary).
