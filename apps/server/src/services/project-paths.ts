// SPDX-License-Identifier: Apache-2.0
//
// Where projects live on disk, and how a project name becomes a safe id.
//
// PROJECT_CONTEXT.md: "filesystem project store (`.scadforge/` per project
// folder). Do not introduce a database." One flat root directory holds one
// directory per project, named by its id; `compose.yaml` bind-mounts the same
// path (`./data/projects`) into the OpenSCAD container.

import { mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isSafeId } from "./validation.js";

/** Env var that relocates the project root (tests, evals, and the eval harness set it). */
export const PROJECTS_DIR_ENV_VAR = "SCADFORGE_PROJECTS_DIR";

/** Default project root, relative to the server process's cwd — matches compose.yaml's bind mount. */
export const DEFAULT_PROJECTS_DIR = join("data", "projects");

/** Resolves the absolute project root directory. */
export function resolveProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[PROJECTS_DIR_ENV_VAR];
  if (raw && raw.trim().length > 0) {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
  return resolve(process.cwd(), DEFAULT_PROJECTS_DIR);
}

/**
 * Absolute directory for one project.
 *
 * Throws on an id that is not a safe single path segment. The routes already
 * guard with the same predicate, but this is the last line before a path join
 * reaches the filesystem, and an id also arrives here from `createProject`'s
 * own slugging — so the check is repeated rather than assumed.
 */
export function projectDir(root: string, projectId: string): string {
  if (!isSafeId(projectId)) throw new Error(`unsafe project id: '${projectId}'`);
  return join(root, projectId);
}

/**
 * Turns a human project name into a safe id stem: lowercase, non-alphanumerics
 * collapsed to `-`, trimmed. Falls back to `project` when a name contains
 * nothing usable (e.g. entirely non-Latin script), since the id is a
 * filesystem path segment, not the display name — `ProjectManifest.name`
 * keeps the original verbatim.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}

/** Ensures the project root exists and returns the ids already in it. */
export async function listProjectIds(root: string): Promise<string[]> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * A unique project id for `name` within `root`: the slug, then `-2`, `-3`, …
 * A suffix collision is resolved by scanning rather than by a random id so
 * project directories stay legible to a human browsing the store.
 */
export async function allocateProjectId(root: string, name: string): Promise<string> {
  const taken = new Set(await listProjectIds(root));
  const stem = slugify(name);
  if (!taken.has(stem)) return stem;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}`;
}
