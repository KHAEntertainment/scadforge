// @docker — Issue #54's central requirements: the source CAS (coherent
// head+source+params revision), the preflight dry run, the acknowledged
// removed/incompatible overrides, the pinned build, and LF normalization.
// Exercises the REAL `ScadCoreApi` (`scad-core-impl.ts`) against a temp
// on-disk project, so the OpenSCAD syntax check / `--export-format=param`
// calls are real container round trips.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@scadforge/scad-core";
import { createScadCoreApi } from "./scad-core-impl.js";
import { createServerRuntime } from "./runtime.js";
import { PROJECTS_DIR_ENV_VAR } from "./project-paths.js";

function dockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const MODEL_SOURCE = "size = 20; // [5:50]\ncube([size, size, size]);\n";
const INVALID_SOURCE = "not valid openscad {{";

let root: string;

function runtimeFor(dir: string) {
  return createServerRuntime({ [PROJECTS_DIR_ENV_VAR]: dir } as NodeJS.ProcessEnv);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scadforge-source-build-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedProject(id = "bracket", content = MODEL_SOURCE) {
  const runtime = runtimeFor(root);
  const dir = runtime.dirFor(id);
  await initProject(dir, { id, name: "Bracket", provider: runtime.provider, content, message: "Initial snapshot" });
  return runtime;
}

describe.skipIf(!dockerAvailable())("@docker Issue #54: source CAS, preflight, save, and pinned build", () => {
  it("getSource returns a non-empty opaque revision", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);

    const source = await api.getSource("bracket");
    expect(source.scad).toBe(MODEL_SOURCE);
    expect(source.revision.length).toBeGreaterThan(0);
    expect(source.head).not.toBeNull();
  }, 60_000);

  it("the revision changes after a source save", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);

    const before = await api.getSource("bracket");
    const saved = await api.updateSource("bracket", {
      scad: "cube([10, 10, 10]);\n",
      base_revision: before.revision
    });
    expect(saved.revision).not.toBe(before.revision);
    expect(saved.scad).toBe("cube([10, 10, 10]);\n");
  }, 60_000);

  it("preflight rejects a stale base_revision with CONFLICT", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);

    const before = await api.getSource("bracket");
    // A snapshot:false params write changes the coherent state (params), so
    // the revision the editor held is now stale.
    await api.updateParams("bracket", { values: { size: 30 }, snapshot: false });

    await expect(
      api.preflightSource("bracket", { scad: "cube([10, 10, 10]);\n", base_revision: before.revision })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }, 60_000);

  it("preflight reports a syntax-invalid source as syntax_ok:false with diagnostics (never a throw)", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    const before = await api.getSource("bracket");

    const result = await api.preflightSource("bracket", { scad: INVALID_SOURCE, base_revision: before.revision });
    expect(result.syntax_ok).toBe(false);
    expect(result.diagnostics).not.toBeNull();
    expect(result.removed_params).toEqual([]);
  }, 60_000);

  it("preflight reports an override the proposed source no longer declares", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    await api.updateParams("bracket", { values: { size: 30 }, snapshot: false });
    const before = await api.getSource("bracket");

    const result = await api.preflightSource("bracket", {
      scad: "cube([10, 10, 10]);\n",
      base_revision: before.revision
    });
    expect(result.syntax_ok).toBe(true);
    expect(result.retained_params).toEqual({});
    expect(result.removed_params).toEqual([{ name: "size", reason: expect.stringContaining("no longer declared") }]);
  }, 60_000);

  it("preflight reports an override whose value is now incompatible (out of range)", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    await api.updateParams("bracket", { values: { size: 30 }, snapshot: false });
    const before = await api.getSource("bracket");

    // The edited source tightens `size` to [40:60]; the current 30 is now below
    // the min, so it must be surfaced as a dropped override.
    const result = await api.preflightSource("bracket", {
      scad: "size = 40; // [40:60]\ncube([size, size, size]);\n",
      base_revision: before.revision
    });
    expect(result.syntax_ok).toBe(true);
    expect(result.removed_params).toEqual([{ name: "size", reason: expect.stringContaining("min") }]);
  }, 60_000);

  it("updateSource requires exactly the dropped overrides to be acknowledged", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    await api.updateParams("bracket", { values: { size: 30 }, snapshot: false });
    const before = await api.getSource("bracket");
    const scad = "cube([10, 10, 10]);\n";

    // Missing acknowledgement -> VALIDATION_FAILED.
    await expect(api.updateSource("bracket", { scad, base_revision: before.revision })).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
    // Extra acknowledgement -> VALIDATION_FAILED.
    await expect(
      api.updateSource("bracket", { scad, base_revision: before.revision, discarded_params: ["size", "nope"] })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Exact acknowledgement -> success, and the dropped override is gone.
    const saved = await api.updateSource("bracket", { scad, base_revision: before.revision, discarded_params: ["size"] });
    expect(saved.params).toEqual({});
    expect((await api.getSource("bracket")).params).toEqual({});
  }, 60_000);

  it("updateSource rejects a stale base_revision with CONFLICT", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    const before = await api.getSource("bracket");
    await api.updateParams("bracket", { values: { size: 30 }, snapshot: false });

    await expect(
      api.updateSource("bracket", {
        scad: "cube([10, 10, 10]);\n",
        base_revision: before.revision,
        discarded_params: ["size"]
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }, 60_000);

  it("updateSource rejects invalid syntax with VALIDATION_FAILED", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    const before = await api.getSource("bracket");

    await expect(api.updateSource("bracket", { scad: INVALID_SOURCE, base_revision: before.revision })).rejects.toMatchObject(
      { code: "VALIDATION_FAILED" }
    );
  }, 60_000);

  it("updateSource normalizes CRLF to LF on save (#40)", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    const before = await api.getSource("bracket");

    const saved = await api.updateSource("bracket", {
      scad: "size = 20; // [5:50]\r\ncube([size, size, size]);\r\n",
      base_revision: before.revision
    });
    expect(saved.scad).not.toContain("\r");
    expect(saved.scad).toBe("size = 20; // [5:50]\ncube([size, size, size]);\n");
  }, 60_000);

  it("build renders and validates the pinned snapshot, attaching the results to it", async () => {
    const runtime = await seedProject();
    const api = createScadCoreApi(runtime);
    const before = await api.getSource("bracket");
    const pinned = before.head!.id;

    const { snapshot } = await api.build("bracket", { base_revision: before.revision });

    expect(snapshot.id).toBe(pinned);
    expect(snapshot.renders.length).toBeGreaterThan(0);
    expect(snapshot.validation).not.toBeNull();
    expect(snapshot.validation!.badge).toBe("green");
  }, 120_000);
});
