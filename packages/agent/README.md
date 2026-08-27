# @scadforge/agent

Claude Agent SDK integration (SDP §11), behind a `ModelProvider` seam so the
underlying model backend can be swapped.

## Module map

| Path | Role |
|---|---|
| `src/tools/contract.ts` | **FROZEN** tool contract for the seven shared tools (`read_project, write_scad, set_params, render_views, validate_mesh, export, library_lookup`). Tech-Lead-owned — changes go through a contract-change issue, not a feature PR (CLAUDE.md hard rule 2). |
| `src/tools/scad-core-api.ts` | The `ScadCoreApi` / `LibraryIndexApi` seams. Type-only imports from `@scadforge/scad-core`; no implementation module is imported. `apps/server` binds the real implementations. |
| `src/tools/handlers.ts` | The seven handlers, as a factory over those seams. No SDK knowledge — `packages/mcp-server` reuses them over stdio. |
| `src/tools/pass-budget.ts` | `SCADFORGE_MAX_PASSES` (default 2) and the green-validation early stop. |
| `src/tools/activity.ts` | Correlates in-process handler outcomes with the SDK's `tool_result` messages. |
| `src/tools/results.ts` | `CallToolResult` builders, error-code mapping, stderr filtering. |
| `src/prompts/` | System prompt and the per-turn user prompt. |
| `src/provider/` | `ModelProvider` interface + `ClaudeAgentSdkProvider`, which hides every Claude-Code-specific option. |
| `src/loop.ts` | `runAgentTurn()` — turn lifecycle events, budget wiring, one `turn_done` always last. |
| `src/sanitize.ts` | Host-side "no `.scad` in chat" enforcement (CLAUDE.md hard rule 5). |
| `src/testing/` | In-memory seam mocks and a scripted SDK, shared with `apps/server` and `packages/mcp-server`. |

## Binding requirements (PROJECT_CONTEXT.md Spike Decisions — Agent SDK)

- `@anthropic-ai/claude-agent-sdk` pinned **exactly** `0.3.246`. Caret ranges hit
  a fatal duplicate-`tool_use`-id bug.
- `settingSources: []` and `tools: []` are set **inside the provider** and are
  never a caller's responsibility. Omitting `settingSources` loads the
  operator's `~/.claude` config (~50,500 extra input tokens per cold run);
  omitting `tools: []` defers the seven schemas behind ToolSearch.
- Usage comes **only** from `stream_event` → `message_delta` with
  `includePartialMessages: true`. `SDKAssistantMessage.message.usage` is a
  `message_start` placeholder and is never summed. `TurnResult.usage` is
  per-pass **and** per-model, so the auxiliary ~900-token `claude-haiku-4-5`
  call the SDK always bills is attributed rather than hidden.
- Tool-result images are MCP `{type:'image', data:<bare base64>,
  mimeType:'image/png'}` blocks, each preceded by a `view: <name>` text label.
  A result carrying images **never** sets `isError: true` — the SDK collapses
  such a result's content to a string and drops every image.
- The pass budget is enforced in the `write_scad` **handler**, not via
  `maxTurns`, so `packages/mcp-server` inherits it.
- Fenced code blocks are stripped from `assistant_text` **host-side**; prompting
  is not sufficient.

## Usage

```ts
import { ClaudeAgentSdkProvider, runAgentTurn } from "@scadforge/agent";

await runAgentTurn({
  projectId,
  message: userMessage,
  provider: new ClaudeAgentSdkProvider(),
  scadCore,      // your ScadCoreApi implementation
  libraries,     // your LibraryIndexApi implementation
  onEvent: (event) => sse.send(event)
});
```

Tests are mock-based: no OpenSCAD, no Docker, no live API call.

License: Apache-2.0 (GPL-free zone — see PROJECT_CONTEXT.md license boundary).
