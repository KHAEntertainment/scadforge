// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3): health-check only.
// Mounted under `API_BASE_PATH` like every other resource — `API_ROUTES.health`
// is `/health`, relative to `/api` (packages/protocol/src/api.ts).

import { Hono } from "hono";
import { API_ROUTES } from "@scadforge/protocol";
import type { HealthResponse } from "@scadforge/protocol";
import { OPENSCAD_IMAGE, OPENSCAD_VERSION } from "@scadforge/scad-core";

/** Bumped alongside `package.json`; no build-time injection in v1. */
const SERVER_VERSION = "0.0.0";

export const healthRoute = new Hono().get(API_ROUTES.health, (c) => {
  const body: HealthResponse = {
    ok: true,
    version: SERVER_VERSION,
    // Frozen pin constants (packages/scad-core/src/types.ts) — reported
    // unconditionally since they describe the toolchain this build targets,
    // not a live container probe (no docker dependency belongs in a route).
    openscad_image: OPENSCAD_IMAGE,
    openscad_version: OPENSCAD_VERSION
  };
  return c.json(body);
});
