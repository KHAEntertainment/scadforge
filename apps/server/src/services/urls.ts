// SPDX-License-Identifier: Apache-2.0
//
// ─────────────────────────────────────────────────────────────────────────────
// THE URL SPACE — resolved seam question from Issue #16.
//
// `packages/agent`'s `ScadCoreApi` declares three methods that are not CAD
// operations at all: `artifactUrl(kind, ref)`, `exportFileName(absolutePath)`
// and `readImageBase64(absolutePath)`. #16 flagged the open question of who
// implements them. The answer is HERE, in `apps/server`, and this file is the
// single place that knows how an on-disk artifact maps to an HTTP path:
//
//   1. Only the server owns the URL space. `API_ROUTES` is the frozen
//      description of it, and this server is what mounts those routes. An
//      `artifactUrl` implementation living in `packages/agent` would have to
//      hard-code a path template it does not serve — a duplicate that goes
//      stale the moment the route file changes, with nothing to catch it.
//   2. `packages/agent` must stay runnable with no HTTP layer at all. From M4
//      `packages/mcp-server` drives the same seven tool handlers over stdio,
//      where there IS no base URL; that host will supply its own mapping (or
//      `null`, which the handlers already treat as "not servable"). Baking one
//      HTTP convention into the agent would make the stdio host lie.
//   3. `readImageBase64` and `exportFileName` are filesystem reads over the
//      `.scadforge/` layout, which is `packages/scad-core`'s and this server's
//      concern. `packages/agent` deliberately imports scad-core as TYPES ONLY
//      (see its `tools/scad-core-api.ts` header) and has no filesystem access
//      of its own.
//
// So the agent's interface is unchanged (it was never wrong — it is a seam the
// HOST fills), and `services/agent-scad-core.ts` implements those three
// methods against the builders below.
// ─────────────────────────────────────────────────────────────────────────────

import { API_BASE_PATH, API_ROUTES } from "@scadforge/protocol";
import type { SnapshotId, ViewName } from "@scadforge/protocol";

/** Substitutes `:param` segments in a frozen route template. */
function buildPath(template: string, params: Record<string, string>): string {
  const path = template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`urls: missing route parameter '${name}' for template '${template}'`);
    return encodeURIComponent(value);
  });
  return `${API_BASE_PATH}${path}`;
}

/** HTTP path for one of a snapshot's rendered PNGs. */
export function renderFileUrl(projectId: string, snapshotId: SnapshotId, view: ViewName): string {
  return buildPath(API_ROUTES.renders.file, { projectId, snapshotId, view });
}

/** HTTP path for an export artifact, by its name relative to `.scadforge/exports/`. */
export function exportFileUrl(projectId: string, file: string): string {
  return buildPath(API_ROUTES.exports.file, { projectId, file });
}

/** HTTP path for a snapshot resource (the `snapshot` artifact kind). */
export function snapshotUrl(projectId: string, snapshotId: SnapshotId): string {
  return buildPath(API_ROUTES.snapshots.get, { projectId, snapshotId });
}

/** HTTP path for a project resource. */
export function projectUrl(projectId: string): string {
  return buildPath(API_ROUTES.projects.get, { projectId });
}
