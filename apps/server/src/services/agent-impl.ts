// SPDX-License-Identifier: Apache-2.0
//
// The REAL `AgentProvider` — Issue #20's replacement for `not-wired.ts`.
//
// Binds `services/agent-provider.ts` to `packages/agent`'s `runAgentTurn` over
// a `ClaudeAgentSdkProvider`, with the CAD seam bound per project by
// `agent-scad-core.ts` and the library seam bound to `packages/libs`.
//
// Event-ownership split (services/agent-provider.ts header): the HOST emits
// `turn_started`, the PROVIDER emits everything else including `turn_done`.
// `runAgentTurn` also emits its own `turn_started` — it is the entry point for
// the stdio MCP host too, which has no separate host layer — so this adapter
// SWALLOWS that one frame and lets every other event through. Doing the
// filtering here (rather than asking the route to tolerate a duplicate) keeps
// both hosts correct against the frozen union: exactly one `turn_started` and
// exactly one `turn_done` per turn, `turn_done` last.

import { ClaudeAgentSdkProvider, runAgentTurn } from "@scadforge/agent";
import type { ModelProvider } from "@scadforge/agent";
import type { SseEvent } from "@scadforge/protocol";
import type { AgentEventSink, AgentProvider, AgentTurnInput } from "./agent-provider.js";
import { createAgentScadCore, createLibraryIndex } from "./agent-scad-core.js";
import { readParams, readProject, readScad, type ServerRuntime } from "./runtime.js";

/** Options for {@link createRealAgentProvider}. */
export interface RealAgentProviderOptions {
  runtime: ServerRuntime;
  /**
   * The model backend. Defaults to a `ClaudeAgentSdkProvider` built from the
   * runtime's `ProviderConfig` — injectable so an integration test can drive
   * the whole wiring without a live model call.
   */
  modelProvider?: ModelProvider;
}

/**
 * True when the project's `model.scad` holds real content rather than the
 * placeholder a fresh project starts with. Drives `hasExistingModel`, which
 * decides whether the turn prompt tells the model to read before it rewrites
 * (prompts/turn.ts — Spike 3 found a turn against an existing model silently
 * discards the user's parameters without it).
 */
function hasRealModel(scad: string): boolean {
  return scad
    .split("\n")
    .some((line) => line.trim().length > 0 && !line.trim().startsWith("//"));
}

/** Builds the real `AgentProvider`. */
export function createRealAgentProvider(options: RealAgentProviderOptions): AgentProvider {
  const { runtime } = options;
  const libraries = createLibraryIndex();
  const modelProvider =
    options.modelProvider ?? new ClaudeAgentSdkProvider({ model: runtime.provider.model ?? undefined });

  return {
    async runTurn(input: AgentTurnInput, onEvent: AgentEventSink): Promise<void> {
      const dir = runtime.dirFor(input.projectId);
      const scadCore = createAgentScadCore({ runtime, projectId: input.projectId });

      // A chat turn may carry parameter overrides. They are persisted BEFORE
      // the turn (`ChatTurnRequest.params`: "Parameter overrides to apply
      // before the turn runs"), so the agent's `read_project` sees the values
      // the user is actually asking about.
      if (input.params && Object.keys(input.params).length > 0) {
        await scadCore.setParams(input.params, 0);
      }

      const scad = await readScad(dir);
      await readProject(dir); // PROJECT_NOT_FOUND surfaces before the model is called
      await readParams(dir);

      // The host already emitted `turn_started` (see the header).
      const forward: AgentEventSink = (event: SseEvent) => {
        if (event.type === "turn_started") return;
        onEvent(event);
      };

      const message =
        input.images.length > 0
          ? // `packages/agent`'s turn prompt is text-only in M1 (annotated-view
            // image input is the Round-3 annotate overlay, SDP §9). Rather than
            // dropping the attachments silently, tell the model they exist.
            `${input.message}\n\n(The user attached ${input.images.length} annotated view(s); image input is not wired in this milestone.)`
          : input.message;

      await runAgentTurn({
        projectId: input.projectId,
        message,
        provider: modelProvider,
        scadCore,
        libraries,
        onEvent: forward,
        turnId: input.turnId,
        maxPasses: input.maxPasses,
        hasExistingModel: hasRealModel(scad),
        librariesAvailable: true,
        model: runtime.provider.model
      });
    }
  };
}
