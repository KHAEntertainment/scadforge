# @scadforge/protocol

**FROZEN (Issue #13).** Types-only package with **zero runtime dependencies**.
Holds the transport contract every other package builds against:

| Module | Contents |
|---|---|
| `src/events.ts` | The SSE event union — `turn_started`, `tool_call`, `tool_result`, `snapshot_created`, `assistant_text`, `turn_done`, `error` — plus turn/usage accounting types. |
| `src/api.ts` | REST request/response shapes and `API_ROUTES` (one group per route file, CLAUDE.md hard rule 3). |
| `src/errors.ts` | The closed `{error_code, message}` vocabulary, shared verbatim by tool results, SSE and HTTP, plus the HTTP status map. |
| `src/snapshot.ts` | The `.scadforge/` on-disk project + history model (SDP §8). |
| `src/vocabulary.ts` | `JsonValue` and the wire vocabulary protocol needs but cannot import — see the MIRROR notice below. |

## Zero dependencies, and the mirror that follows from it

This package sits at the bottom of the dependency graph. The only legal
directions are `scad-core → protocol` and `agent → {protocol, scad-core}`;
protocol imports from no workspace package at all.

That means it cannot import the CAD vocabulary it needs at the transport
boundary, so `src/vocabulary.ts` re-declares `ViewName`, `ExportFormat`,
`ParamValue` and `ToolName`, whose canonical definitions live in
`packages/scad-core/src/types.ts` and `packages/agent/src/tools/contract.ts`.
Drift is guarded by compile-time **and** runtime assertions in
`packages/scad-core/src/types.test.ts` and
`packages/agent/src/tools/contract.test.ts` — both fail CI if either side
changes without the other.

## Frozen

`packages/protocol/**` is Tech-Lead-owned now that Issue #13 has merged. Do not
edit it inside a feature PR; request a change via a Tech-Lead-approved
contract-change issue (CLAUDE.md hard rule 2).

License: Apache-2.0 (GPL-free zone — see PROJECT_CONTEXT.md license boundary).
