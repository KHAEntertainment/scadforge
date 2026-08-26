// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation and error-mapping only; everything else
// delegates to the injected `ScadCoreApi`.

import { Hono } from "hono";
import { API_ROUTES } from "@scadforge/protocol";
import type { CreateProjectRequest, ListProjectsResponse, ProjectResponse } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { isNonEmptyString, isSafeId } from "../services/validation.js";

export function createProjectsRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.get(API_ROUTES.projects.list, async (c) => {
    try {
      const body: ListProjectsResponse = await scadCore.listProjects();
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.post(API_ROUTES.projects.create, async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be valid JSON."), 400);
    }
    const candidate = payload as Partial<CreateProjectRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (!isNonEmptyString(candidate.name)) {
      return c.json(errorBody("INVALID_REQUEST", "`name` is required and must be a non-empty string."), 400);
    }
    if (candidate.scad !== undefined && typeof candidate.scad !== "string") {
      return c.json(errorBody("INVALID_REQUEST", "`scad` must be a string when provided."), 400);
    }

    try {
      const body: ProjectResponse = await scadCore.createProject({
        name: candidate.name,
        scad: candidate.scad
      });
      return c.json(body, 201);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.get(API_ROUTES.projects.get, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }
    try {
      const body: ProjectResponse = await scadCore.getProject(projectId);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
