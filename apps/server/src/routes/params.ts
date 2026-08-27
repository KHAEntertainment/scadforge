// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation and error-mapping only.
//
// GLUE (Issue #20): `API_ROUTES.params` has been in the frozen contract since
// #13 and `apps/web`'s Params tab is written against it, but no route file
// implemented it — #17 shipped projects/chat/snapshots/renders/export. Adding
// it here (rather than folding params into `projects.ts`) is what hard rule 3
// requires, and it is what makes the Customizer schema — the thing Scenario A
// asserts on — reachable over HTTP at all.

import { Hono } from "hono";
import { API_ROUTES } from "@scadforge/protocol";
import type { ParamsResponse, ParamsUpdateRequest } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { isSafeId } from "../services/validation.js";

function isParamValues(value: unknown): value is ParamsUpdateRequest["values"] {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createParamsRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.get(API_ROUTES.params.get, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }
    try {
      const body: ParamsResponse = await scadCore.getParams(projectId);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.put(API_ROUTES.params.update, async (c) => {
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
    const candidate = payload as Partial<ParamsUpdateRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (!isParamValues(candidate.values)) {
      return c.json(errorBody("INVALID_REQUEST", "`values` is required and must be an object of parameter values."), 400);
    }
    if (candidate.snapshot !== undefined && typeof candidate.snapshot !== "boolean") {
      return c.json(errorBody("INVALID_REQUEST", "`snapshot` must be a boolean when provided."), 400);
    }

    try {
      const body: ParamsResponse = await scadCore.updateParams(projectId, {
        values: candidate.values,
        snapshot: candidate.snapshot ?? true
      });
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
