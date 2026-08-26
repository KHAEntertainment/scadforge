import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScadForgeError } from "../errors.js";
import { stageWork } from "./workdir.js";

let sourceDir: string;
let scadPath: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), "scadcore-workdir-src-"));
  scadPath = join(sourceDir, "model.scad");
  await writeFile(scadPath, "cube(10);\n", "utf8");
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
});

describe("stageWork", () => {
  it("stages the model file by its basename into a fresh mkdtemp directory with a views/ subdir", async () => {
    const work = await stageWork(scadPath);
    try {
      expect(work.modelName).toBe("model.scad");
      const stats = await stat(join(work.dir, "model.scad"));
      expect(stats.isFile()).toBe(true);
      const viewsStat = await stat(join(work.dir, "views"));
      expect(viewsStat.isDirectory()).toBe(true);
      // Each call gets its OWN directory (per-render mkdtemp, not shared/reused).
      expect(work.dir).not.toBe(sourceDir);
    } finally {
      await work.cleanup();
    }
  });

  it("copies libraryPaths directories into the work root by their own basename", async () => {
    const libDir = await mkdtemp(join(tmpdir(), "scadcore-workdir-lib-"));
    const libNamed = join(libDir, "MyLib");
    await mkdir(libNamed, { recursive: true });
    await writeFile(join(libNamed, "helper.scad"), "module helper() {}\n", "utf8");

    const work = await stageWork(scadPath, { libraryPaths: [libNamed] });
    try {
      const stats = await stat(join(work.dir, "MyLib", "helper.scad"));
      expect(stats.isFile()).toBe(true);
    } finally {
      await work.cleanup();
      await rm(libDir, { recursive: true, force: true });
    }
  });

  it("cleanup() removes the staged directory and is safe to call more than once", async () => {
    const work = await stageWork(scadPath);
    await work.cleanup();
    await expect(readdir(work.dir)).rejects.toThrow();
    await expect(work.cleanup()).resolves.not.toThrow(); // idempotent
  });

  it("each call is isolated: two concurrent stageWork calls on the same source never share a directory", async () => {
    const [a, b] = await Promise.all([stageWork(scadPath), stageWork(scadPath)]);
    try {
      expect(a.dir).not.toBe(b.dir);
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });

  // COUNTEREXAMPLE: a source file that does not exist.
  it("a missing source .scad file -> typed RENDER_FAILED, never an uncaught fs error", async () => {
    await expect(stageWork(join(sourceDir, "does-not-exist.scad"))).rejects.toBeInstanceOf(ScadForgeError);
  });
});
