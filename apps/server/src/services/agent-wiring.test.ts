// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for the Issue #20 wiring that needs NO Docker and no live
// model: the three host-owned seam mappings, and the provider adapter's event
// contract (exactly one `turn_started`, emitted by the host, and exactly one
// `turn_done`, emitted last).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SseEvent } from "@scadforge/protocol";
import type { AgentToolSet, ModelProvider, TurnInput, TurnResult } from "@scadforge/agent";
import { initProject, snapshotRenderPath } from "@scadforge/scad-core";
import { createAgentScadCore, createLibraryIndex } from "./agent-scad-core.js";
import { createRealAgentProvider } from "./agent-impl.js";
import { createServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";
import { exportFileUrl, renderFileUrl, snapshotUrl } from "./urls.js";

let root: string;

function runtimeFor(dir: string) {
  return createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: dir } as NodeJS.ProcessEnv);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scadforge-agent-wiring-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedProject(id = "bracket", content = "cube([10,10,10]);\n") {
  const runtime = runtimeFor(root);
  const dir = runtime.dirFor(id);
  await initProject(dir, { id, name: "Bracket", provider: runtime.provider, content, message: "Initial snapshot" });
  return { runtime, dir };
}

describe("agent seam: artifactUrl / exportFileName (Issue #16's open question, answered host-side)", () => {
  it("maps a snapshot ref onto the snapshot route", async () => {
    const { runtime, dir } = await seedProject();
    const scadCore = createAgentScadCore({ runtime, projectId: "bracket" });
    void dir;
    expect(scadCore.artifactUrl("snapshot", "0002")).toBe(snapshotUrl("bracket", "0002"));
  });

  it("maps a rendered PNG's absolute path back onto the render route", async () => {
    const { runtime, dir } = await seedProject();
    const scadCore = createAgentScadCore({ runtime, projectId: "bracket" });
    const png = snapshotRenderPath(dir, "0001", "iso");
    expect(scadCore.artifactUrl("render", png)).toBe(renderFileUrl("bracket", "0001", "iso"));
  });

  it("returns null for a render path outside the project's history", async () => {
    const { runtime } = await seedProject();
    const scadCore = createAgentScadCore({ runtime, projectId: "bracket" });
    expect(scadCore.artifactUrl("render", "/tmp/elsewhere/iso.png")).toBeNull();
  });

  it("returns null for a validation mesh, which is a throwaway intermediate", async () => {
    const { runtime } = await seedProject();
    const scadCore = createAgentScadCore({ runtime, projectId: "bracket" });
    expect(scadCore.artifactUrl("mesh", "/tmp/scadforge-x/validate.stl")).toBeNull();
  });

  it("maps an export artifact onto the export route and names it relative to exports/", async () => {
    const { runtime, dir } = await seedProject();
    const scadCore = createAgentScadCore({ runtime, projectId: "bracket" });
    const artifact = join(dir, ".scadforge", "exports", "bracket-0001.3mf");
    expect(scadCore.artifactUrl("export", artifact)).toBe(exportFileUrl("bracket", "bracket-0001.3mf"));
    expect(scadCore.exportFileName(artifact)).toBe("bracket-0001.3mf");
  });

  it("reads a rendered PNG as BARE base64 (no data: prefix)", async () => {
    const { runtime, dir } = await seedProject();
    const scadCore = createAgentScadCore({ runtime, projectId: "bracket" });
    const { mkdir, writeFile } = await import("node:fs/promises");
    const png = snapshotRenderPath(dir, "0001", "iso");
    // Post-creation renders physically live under `.scadforge/derived/<id>/`
    // (Issue #45), never `history/<id>/views/` -- `snapshotRenderPath` builds
    // that path, so mkdir its actual parent.
    await mkdir(join(dir, ".scadforge", "derived", "0001", "views"), { recursive: true });
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const base64 = await scadCore.readImageBase64(png);
    expect(base64).toBe("iVBORw==");
    expect(base64.startsWith("data:")).toBe(false);
  });
});

describe("library seam (packages/libs)", () => {
  it("answers a lookup against the committed index with LibrarySymbol entries", async () => {
    const results = await createLibraryIndex().lookup({ query: "threaded rod", library: "BOSL2", limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ library: "BOSL2" });
    expect(typeof results[0].include).toBe("string");
    expect(typeof results[0].signature).toBe("string");
  });

  it("rejects an empty query with a typed error rather than returning the whole index", async () => {
    await expect(createLibraryIndex().lookup({ query: "   " })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });
});

/** A `ModelProvider` that runs no model at all — it just reports a finished turn. */
function stubModelProvider(onRun?: (input: TurnInput) => void): ModelProvider {
  return {
    id: "stub",
    async runTurn(input: TurnInput, _tools: AgentToolSet, onEvent): Promise<TurnResult> {
      onRun?.(input);
      onEvent({ type: "assistant_text", turn_id: input.turnId, text: "done" });
      return { status: "completed", summary: "A stub turn.", passesUsed: 1, usage: null, durationMs: 1 };
    }
  };
}

describe("AgentProvider adapter", () => {
  it("emits exactly one turn_done, last, and no turn_started (the host owns that frame)", async () => {
    const { runtime } = await seedProject();
    const provider = createRealAgentProvider({ runtime, modelProvider: stubModelProvider() });

    const events: SseEvent[] = [];
    await provider.runTurn(
      { projectId: "bracket", turnId: "turn-1", message: "make it wider", images: [], maxPasses: 2 },
      (event) => events.push(event)
    );

    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(0);
    expect(events.filter((e) => e.type === "turn_done")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn_done");
    expect(events.some((e) => e.type === "assistant_text")).toBe(true);
  });

  it("threads the host's turn id and pass budget into the turn", async () => {
    const { runtime } = await seedProject();
    let seen: TurnInput | null = null;
    const provider = createRealAgentProvider({
      runtime,
      modelProvider: stubModelProvider((input) => {
        seen = input;
      })
    });

    const events: SseEvent[] = [];
    await provider.runTurn(
      { projectId: "bracket", turnId: "turn-abc", message: "hello", images: [], maxPasses: 1 },
      (event) => events.push(event)
    );

    expect(seen).not.toBeNull();
    expect(seen!.turnId).toBe("turn-abc");
    expect(seen!.projectId).toBe("bracket");
    const done = events.at(-1) as Extract<SseEvent, { type: "turn_done" }>;
    expect(done.turn_id).toBe("turn-abc");
  });

  it("tells a project with real geometry to read before it rewrites, and a placeholder project not to", async () => {
    const withModel = await seedProject("has-model", "cube([10,10,10]);\n");
    let prompt = "";
    await createRealAgentProvider({
      runtime: withModel.runtime,
      modelProvider: stubModelProvider((input) => {
        prompt = input.prompt;
      })
    }).runTurn({ projectId: "has-model", turnId: "t", message: "wider", images: [], maxPasses: 2 }, () => {});
    expect(prompt).toContain("already has a model.scad");

    const fresh = await seedProject("fresh", "// New ScadForge project.\n");
    let freshPrompt = "";
    await createRealAgentProvider({
      runtime: fresh.runtime,
      modelProvider: stubModelProvider((input) => {
        freshPrompt = input.prompt;
      })
    }).runTurn({ projectId: "fresh", turnId: "t", message: "a bracket", images: [], maxPasses: 2 }, () => {});
    expect(freshPrompt).toBe("Build this: a bracket");
  });

  it("surfaces a missing project as a typed failure instead of calling the model", async () => {
    const { runtime } = await seedProject();
    let called = false;
    const provider = createRealAgentProvider({
      runtime,
      modelProvider: stubModelProvider(() => {
        called = true;
      })
    });
    await expect(
      provider.runTurn({ projectId: "nope", turnId: "t", message: "hi", images: [], maxPasses: 2 }, () => {})
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(called).toBe(false);
  });
});
