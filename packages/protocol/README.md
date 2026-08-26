# @scadforge/protocol

Types-only package with zero runtime dependencies. Holds the shared
TypeScript types and zod schemas that form the ScadForge API/SSE contract
(SDP §11): the SSE event union (`turn_started`, `tool_call`, `tool_result`,
`snapshot_created`, `assistant_text`, `turn_done`, `error`) and other
cross-package request/response shapes.

This package is frozen once its contract-freeze issue (Issue #10) merges —
after that, changes go through the Tech Lead, not feature PRs (see
CLAUDE.md hard rule 2).

License: Apache-2.0 (GPL-free zone — see PROJECT_CONTEXT.md license boundary).
