import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECTS_DIR,
  PROJECTS_DIR_ENV_VAR,
  allocateProjectId,
  listProjectIds,
  projectDir,
  resolveProjectsRoot,
  slugify
} from "./project-paths.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scadforge-projects-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveProjectsRoot", () => {
  it("defaults to data/projects under the process cwd (compose.yaml's bind mount)", () => {
    expect(resolveProjectsRoot({})).toBe(resolve(process.cwd(), DEFAULT_PROJECTS_DIR));
  });

  it("honours an absolute override", () => {
    expect(resolveProjectsRoot({ [PROJECTS_DIR_ENV_VAR]: "/srv/scadforge" })).toBe("/srv/scadforge");
  });

  it("resolves a relative override against the cwd", () => {
    expect(resolveProjectsRoot({ [PROJECTS_DIR_ENV_VAR]: "tmp/projects" })).toBe(resolve(process.cwd(), "tmp/projects"));
  });

  it("ignores a blank override", () => {
    expect(resolveProjectsRoot({ [PROJECTS_DIR_ENV_VAR]: "   " })).toBe(resolve(process.cwd(), DEFAULT_PROJECTS_DIR));
  });
});

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    expect(slugify("Wall-Mount Bracket (32mm)")).toBe("wall-mount-bracket-32mm");
  });

  it("trims leading/trailing separators", () => {
    expect(slugify("  ...bracket...  ")).toBe("bracket");
  });

  it("falls back to a usable stem when nothing survives", () => {
    expect(slugify("!!!")).toBe("project");
    expect(slugify("")).toBe("project");
  });

  it("bounds the length so the id stays a sane path segment", () => {
    expect(slugify("a".repeat(200)).length).toBe(48);
  });
});

describe("projectDir", () => {
  it("joins a safe id onto the root", () => {
    expect(projectDir(root, "bracket")).toBe(join(root, "bracket"));
  });

  it("refuses a traversal id even though the routes already guard", () => {
    expect(() => projectDir(root, "../etc")).toThrow(/unsafe project id/);
    expect(() => projectDir(root, "a/b")).toThrow(/unsafe project id/);
  });
});

describe("allocateProjectId", () => {
  it("returns the bare slug when it is free", async () => {
    await expect(allocateProjectId(root, "Bracket")).resolves.toBe("bracket");
  });

  it("suffixes on collision rather than overwriting an existing project", async () => {
    await mkdir(join(root, "bracket"), { recursive: true });
    await expect(allocateProjectId(root, "Bracket")).resolves.toBe("bracket-2");
    await mkdir(join(root, "bracket-2"), { recursive: true });
    await expect(allocateProjectId(root, "bracket")).resolves.toBe("bracket-3");
  });

  it("creates the root if it does not exist yet", async () => {
    const fresh = join(root, "nested", "deeper");
    await expect(allocateProjectId(fresh, "Bracket")).resolves.toBe("bracket");
    await expect(listProjectIds(fresh)).resolves.toEqual([]);
  });
});

describe("listProjectIds", () => {
  it("lists directories only, sorted, skipping files and unsafe names", async () => {
    await mkdir(join(root, "beta"), { recursive: true });
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(join(root, "notes.txt"), "not a project");
    await expect(listProjectIds(root)).resolves.toEqual(["alpha", "beta"]);
  });
});
