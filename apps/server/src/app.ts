// SPDX-License-Identifier: Apache-2.0
//
// Composition root: wires the (injected) `ScadCoreApi` and `AgentProvider`
// implementations into one route file per resource (CLAUDE.md hard rule 3).
// Exported separately from the entry point so tests can exercise the app
// without binding a real network port, and so Issue #20 can swap in the real
// implementations without touching any route file.

import { Hono } from "hono";
import { API_BASE_PATH } from "@scadforge/protocol";
import { MAX_PASSES_ENV_VAR, DEFAULT_MAX_PASSES } from "@scadforge/agent";
import { healthRoute } from "./routes/health.js";
import { createProjectsRoute } from "./routes/projects.js";
import { createChatRoute } from "./routes/chat.js";
import { createSnapshotsRoute } from "./routes/snapshots.js";
import { createRendersRoute } from "./routes/renders.js";
import { createExportRoute } from "./routes/export.js";
import { bodySizeLimit } from "./middleware/body-limit.js";
import { errorBody } from "./services/errors.js";
import type { ScadCoreApi } from "./services/scad-core-api.js";
import type { AgentProvider } from "./services/agent-provider.js";

export interface AppDeps {
  scadCore: ScadCoreApi;
  agent: AgentProvider;
  /** Overrides `SCADFORGE_MAX_PASSES` / the frozen default. Mainly for tests. */
  defaultMaxPasses?: number;
}

function resolveDefaultMaxPasses(override: number | undefined): number {
  if (override !== undefined) return override;
  const raw = process.env[MAX_PASSES_ENV_VAR];
  if (raw === undefined) return DEFAULT_MAX_PASSES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MAX_PASSES;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use("*", bodySizeLimit());

  // `API_ROUTES.health` is `/health`, relative to `API_BASE_PATH` like every
  // other frozen route — mounted here, not at bare `/`.
  app.route(API_BASE_PATH, healthRoute);
  app.route(API_BASE_PATH, createProjectsRoute(deps.scadCore));
  app.route(
    API_BASE_PATH,
    createChatRoute(deps.scadCore, deps.agent, { defaultMaxPasses: resolveDefaultMaxPasses(deps.defaultMaxPasses) })
  );
  app.route(API_BASE_PATH, createSnapshotsRoute(deps.scadCore));
  app.route(API_BASE_PATH, createRendersRoute(deps.scadCore));
  app.route(API_BASE_PATH, createExportRoute(deps.scadCore));

  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Route not found."), 404));

  // Last-resort safety net (AC: "process never crashes on a failed render").
  // Every route already catches and maps its own failures; this only fires
  // for a genuinely unexpected throw (e.g. a bug), and it still returns a
  // normal frozen-shape response instead of letting Node tear down the
  // process on an unhandled rejection from a route handler.
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : "Unexpected server error.";
    return c.json(errorBody("INTERNAL_ERROR", message), 500);
  });

  return app;
}
