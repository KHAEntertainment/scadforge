// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation and error-mapping only; the pinned render +
// validate itself delegates to the injected `ScadCoreApi`.

import { Hono } from "hono";
import { API_ROUTES } from "@scadforge/protocol";
import type { BuildRequest, BuildResponse } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { isNonEmptyString, isSafeId } from "../services/validation.js";

export function createBuildRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.post(API_ROUTES.build.create, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be valid JSON."), 400);
    }
    const candidate = payload as Partial<BuildRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (!isNonEmptyString(candidate.base_revision)) {
      return c.json(errorBody("INVALID_REQUEST", "`base_revision` is required and must be a non-empty string."), 400);
    }

    try {
      const body: BuildResponse = await scadCore.build(projectId, { base_revision: candidate.base_revision });
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
