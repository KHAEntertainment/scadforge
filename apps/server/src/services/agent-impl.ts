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
 * Set to `"0"` to disable CLI stderr forwarding (Issue #75 AC). Default is
 * enabled — the bundled CLI's stderr is otherwise the only place MCP
 * connection and API diagnostics for a turn are visible at all.
 */
export const AGENT_STDERR_ENV_VAR = "SCADFORGE_AGENT_STDERR";

/** Never let an unterminated stderr chunk grow the carry buffer forever. */
const STDERR_CARRY_LIMIT = 4096;

/** What {@link createAgentStderrForwarder} returns; `null` when disabled. */
export interface AgentStderrForwarder {
  /** Passed straight through as `ClaudeAgentSdkProviderOptions.onStderr`. */
  onStderr: (data: string) => void;
  /**
   * Call with the running turn's id at the start of `runTurn`, and with
   * `null` once it ends, so lines are stamped with the turn that actually
   * produced them. A line that arrives outside any active turn (subprocess
   * startup/teardown) is stamped `[agent]`.
   */
  setCurrentTurnId: (turnId: string | null) => void;
}

/**
 * Builds the CLI stderr forwarder wired into the default `ClaudeAgentSdkProvider`
 * (Issue #75): the subprocess's stderr — where MCP-connection and API
 * diagnostics land — was previously discarded entirely (no `onStderr` was
 * ever passed), so nothing about a live turn was observable from the server.
 *
 * One `process.stderr.write` per stderr *event* (one subprocess data chunk),
 * never one per line: chunk boundaries do not line up with newlines, and a
 * chatty subprocess must not turn into a synchronous-write storm. Lines
 * within one chunk are still each stamped individually. An unterminated tail
 * is carried to the next chunk but capped at {@link STDERR_CARRY_LIMIT} —
 * past that it is flushed as-is instead of grown forever, so a pathological
 * stream can never buffer without bound here.
 */
export function createAgentStderrForwarder(
  env: NodeJS.ProcessEnv = process.env
): AgentStderrForwarder | null {
  if (env[AGENT_STDERR_ENV_VAR] === "0") return null;

  let currentTurnId: string | null = null;
  let carry = "";

  const onStderr = (data: string): void => {
    carry += data;
    const lines: string[] = [];
    let newlineAt: number;
    while ((newlineAt = carry.indexOf("\n")) !== -1) {
      lines.push(carry.slice(0, newlineAt));
      carry = carry.slice(newlineAt + 1);
    }
    if (carry.length > STDERR_CARRY_LIMIT) {
      lines.push(carry);
      carry = "";
    }
    const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
    if (nonEmpty.length === 0) return;
    const prefix = currentTurnId ? `[turn ${currentTurnId}]` : "[agent]";
    process.stderr.write(nonEmpty.map((line) => `${prefix} ${line}`).join("\n") + "\n");
  };

  return {
    onStderr,
    setCurrentTurnId: (turnId) => {
      currentTurnId = turnId;
    }
  };
}

/** Builds the default provider + forwarder pair exactly as production does. */
function buildDefaultProvider(
  runtime: ServerRuntime,
  env: NodeJS.ProcessEnv
): { provider: ClaudeAgentSdkProvider; forwarder: AgentStderrForwarder | null } {
  const forwarder = createAgentStderrForwarder(env);
  const provider = new ClaudeAgentSdkProvider({
    model: runtime.provider.model ?? undefined,
    onStderr: forwarder?.onStderr
  });
  return { provider, forwarder };
}

/**
 * Exposed for the wiring test (Issue #75 AC): builds exactly the model
 * provider `createRealAgentProvider` uses when the caller supplies no
 * override, so `onStderr` wiring can be asserted without spawning the
 * bundled CLI.
 */
export function buildDefaultModelProvider(
  runtime: ServerRuntime,
  env: NodeJS.ProcessEnv = process.env
): ModelProvider {
  return buildDefaultProvider(runtime, env).provider;
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
  // An injected `modelProvider` (tests, the eval harness) owns its own stderr
  // wiring, if any; only the default construction gets the forwarder below.
  const defaultBuild = options.modelProvider ? null : buildDefaultProvider(runtime, process.env);
  const modelProvider = options.modelProvider ?? defaultBuild!.provider;
  const forwarder = defaultBuild?.forwarder ?? null;

  async function runOneTurn(input: AgentTurnInput, onEvent: AgentEventSink): Promise<void> {
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

  return {
    async runTurn(input: AgentTurnInput, onEvent: AgentEventSink): Promise<void> {
      forwarder?.setCurrentTurnId(input.turnId);
      try {
        await runOneTurn(input, onEvent);
      } finally {
        forwarder?.setCurrentTurnId(null);
      }
    }
  };
}
