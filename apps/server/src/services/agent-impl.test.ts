// SPDX-License-Identifier: Apache-2.0
//
// Issue #75: `createAgentStderrForwarder` (the line-splitting, bounded,
// turn-stamping wrapper around the SDK's `onStderr`) and the wiring that puts
// it into the default `ClaudeAgentSdkProvider`. No live model call and no
// bundled CLI spawn — `buildDefaultModelProvider` is driven with a fake SDK
// binding, exactly like `packages/agent`'s own provider tests.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassBudget, ToolActivityRecorder, createToolHandlers, testing } from "@scadforge/agent";
import type { AgentToolSet, ClaudeAgentSdkProvider, TurnInput } from "@scadforge/agent";
import {
  AGENT_STDERR_ENV_VAR,
  buildDefaultModelProvider,
  createAgentStderrForwarder
} from "./agent-impl.js";
import { createServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scadforge-agent-impl-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runtimeFor(dir: string) {
  return createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: dir } as NodeJS.ProcessEnv);
}

/** Minimal `AgentToolSet`, mirroring `packages/agent`'s own provider tests. */
function toolSet(): AgentToolSet {
  const budget = new PassBudget({ maxPasses: 2 });
  const activity = new ToolActivityRecorder();
  const handlers = createToolHandlers({
    scadCore: new testing.MockScadCore(),
    libraries: new testing.MockLibraryIndex(),
    budget,
    activity,
    turnId: "turn-1",
    projectId: "proj-1",
    emit: () => {}
  });
  return { handlers, budget, activity };
}

function turnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    turnId: "turn-1",
    projectId: "proj-1",
    prompt: "Build this: a 20mm bracket",
    systemPrompt: "system",
    ...overrides
  };
}

describe("createAgentStderrForwarder", () => {
  it("is disabled by SCADFORGE_AGENT_STDERR=0", () => {
    expect(createAgentStderrForwarder({ [AGENT_STDERR_ENV_VAR]: "0" })).toBeNull();
  });

  it("is enabled by default (env var unset or any other value)", () => {
    expect(createAgentStderrForwarder({})).not.toBeNull();
    expect(createAgentStderrForwarder({ [AGENT_STDERR_ENV_VAR]: "1" })).not.toBeNull();
  });

  it("prefixes a forwarded line with the current turn id, and [agent] when none is set", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("connecting to mcp server\n");
      expect(spy).toHaveBeenCalledWith("[agent] connecting to mcp server\n");

      spy.mockClear();
      forwarder.setCurrentTurnId("turn-abc");
      forwarder.onStderr("tool call started\n");
      expect(spy).toHaveBeenCalledWith("[turn turn-abc] tool call started\n");

      spy.mockClear();
      forwarder.setCurrentTurnId(null);
      forwarder.onStderr("cleanup\n");
      expect(spy).toHaveBeenCalledWith("[agent] cleanup\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("stamps every line from one chunk, in a single write call (never one syscall per line)", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("line one\nline two\nline three\n");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("[agent] line one\n[agent] line two\n[agent] line three\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("carries an unterminated tail across chunks and reassembles the full line", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("half a ");
      expect(spy).not.toHaveBeenCalled();
      forwarder.onStderr("line\n");
      expect(spy).toHaveBeenCalledWith("[agent] half a line\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("never buffers an unterminated chunk unboundedly: it is flushed once it crosses the cap", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const huge = "x".repeat(5000); // past STDERR_CARRY_LIMIT, no trailing newline
      forwarder.onStderr(huge);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(`[agent] ${huge}\n`);

      // The carry was reset, not left holding the flushed text.
      spy.mockClear();
      forwarder.onStderr("next\n");
      expect(spy).toHaveBeenCalledWith("[agent] next\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("drops whitespace-only lines without writing", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("   \n\n");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("buildDefaultModelProvider (Issue #75 server wiring)", () => {
  it("wires onStderr into the default ClaudeAgentSdkProvider by default", async () => {
    const runtime = runtimeFor(root);
    const provider = buildDefaultModelProvider(runtime) as ClaudeAgentSdkProvider;
    const sdk = testing.createFakeSdk({ turns: [] });
    const built = provider.buildQuery(sdk.binding, turnInput(), toolSet());
    expect(typeof built.options.stderr).toBe("function");
    expect(built.options.strictMcpConfig).toBe(true);
  });

  it("omits onStderr when SCADFORGE_AGENT_STDERR=0", async () => {
    const runtime = runtimeFor(root);
    const provider = buildDefaultModelProvider(runtime, {
      ...process.env,
      [AGENT_STDERR_ENV_VAR]: "0"
    }) as ClaudeAgentSdkProvider;
    const sdk = testing.createFakeSdk({ turns: [] });
    const built = provider.buildQuery(sdk.binding, turnInput(), toolSet());
    expect(built.options.stderr).toBeUndefined();
  });
});
