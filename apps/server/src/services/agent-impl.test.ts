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

  it("prefixes a forwarded line with the turn id passed alongside it", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("tool call started\n", "turn-abc");
      expect(spy).toHaveBeenCalledWith("[turn turn-abc] tool call started\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("stamps every line from one chunk, in a single write call (never one syscall per line)", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("line one\nline two\nline three\n", "turn-1");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("[turn turn-1] line one\n[turn turn-1] line two\n[turn turn-1] line three\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("carries an unterminated tail across chunks and reassembles the full line", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("half a ", "turn-1");
      expect(spy).not.toHaveBeenCalled();
      forwarder.onStderr("line\n", "turn-1");
      expect(spy).toHaveBeenCalledWith("[turn turn-1] half a line\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("never buffers an unterminated chunk unboundedly: it is flushed once it crosses the cap", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const huge = "x".repeat(5000); // past STDERR_CARRY_LIMIT, no trailing newline
      forwarder.onStderr(huge, "turn-1");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(`[turn turn-1] ${huge}\n`);

      // The carry was reset, not left holding the flushed text.
      spy.mockClear();
      forwarder.onStderr("next\n", "turn-1");
      expect(spy).toHaveBeenCalledWith("[turn turn-1] next\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("drops whitespace-only lines without writing", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("   \n\n", "turn-1");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Issue #75 QA fix 2: `chat.ts` locks per PROJECT, not globally, so two
  // turns on different projects can run concurrently against the SAME
  // provider instance and forwarder. State must be keyed by turn id.
  it("keeps a separate carry buffer per turn id -- concurrent turns never bleed into each other's lines", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("half of A's line ", "turn-A");
      forwarder.onStderr("all of B's line\n", "turn-B");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("[turn turn-B] all of B's line\n");

      spy.mockClear();
      forwarder.onStderr("continues\n", "turn-A");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("[turn turn-A] half of A's line continues\n");
    } finally {
      spy.mockRestore();
    }
  });

  it("endTurn flushes a trailing unterminated line for that turn and clears its state", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("dangling, no newline", "turn-A");
      expect(spy).not.toHaveBeenCalled();
      forwarder.endTurn("turn-A");
      expect(spy).toHaveBeenCalledWith("[turn turn-A] dangling, no newline\n");

      // A second endTurn on the same (now-cleared) id is a harmless no-op.
      spy.mockClear();
      forwarder.endTurn("turn-A");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("endTurn on an id with no dangling line, or with no state at all, does nothing", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      forwarder.onStderr("complete line\n", "turn-A");
      spy.mockClear();
      forwarder.endTurn("turn-A"); // already flushed, carry is empty
      forwarder.endTurn("turn-never-seen");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Issue #75 QA fix 1: the vendored SDK calls `onStderr` from a raw stream
  // 'data' handler with no try/catch of its own -- an uncaught throw here
  // would crash the whole server, not just the turn.
  it("never throws even when the underlying write fails (e.g. EPIPE), and drops the line instead", () => {
    const forwarder = createAgentStderrForwarder({})!;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    try {
      expect(() => forwarder.onStderr("line one\n", "turn-A")).not.toThrow();
      expect(() => forwarder.onStderr("line two\n", "turn-A")).not.toThrow();
      expect(() => forwarder.endTurn("turn-A")).not.toThrow();

      // One attempted write per line-bearing call, plus the "dropped" notice
      // logged exactly once for the turn (not once per dropped line).
      expect(spy).toHaveBeenCalledTimes(3);
      const droppedNotices = spy.mock.calls.filter(([line]) =>
        String(line).includes("further lines are dropped silently")
      );
      expect(droppedNotices).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a turn whose writes are failing does not affect a concurrent turn's forwarding", () => {
    const forwarder = createAgentStderrForwarder({})!;
    let failA = true;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      if (failA && String(chunk).includes("turn-A")) throw new Error("EPIPE");
      return true;
    });
    try {
      expect(() => forwarder.onStderr("line\n", "turn-A")).not.toThrow();
      failA = false;
      spy.mockClear();
      forwarder.onStderr("still working\n", "turn-B");
      expect(spy).toHaveBeenCalledWith("[turn turn-B] still working\n");
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
