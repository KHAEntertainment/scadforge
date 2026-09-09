// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation and error-mapping only; everything else
// (the CAS save, the preflight dry run, the coherent-revision read) delegates
// to the injected `ScadCoreApi`.

import { Hono } from "hono";
import { API_ROUTES } from "@scadforge/protocol";
import type { SourcePreflightRequest, SourceResponse, SourceUpdateRequest } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { isNonEmptyString, isSafeId } from "../services/validation.js";

export function createSourceRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.get(API_ROUTES.source.get, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }
    try {
      const body: SourceResponse = await scadCore.getSource(projectId);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.post(API_ROUTES.source.preflight, async (c) => {
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
    const candidate = payload as Partial<SourcePreflightRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (typeof candidate.scad !== "string") {
      return c.json(errorBody("INVALID_REQUEST", "`scad` is required and must be a string."), 400);
    }
    if (!isNonEmptyString(candidate.base_revision)) {
      return c.json(errorBody("INVALID_REQUEST", "`base_revision` is required and must be a non-empty string."), 400);
    }

    try {
      const body = await scadCore.preflightSource(projectId, {
        scad: candidate.scad,
        base_revision: candidate.base_revision
      });
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.put(API_ROUTES.source.update, async (c) => {
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
    const candidate = payload as Partial<SourceUpdateRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (typeof candidate.scad !== "string") {
      return c.json(errorBody("INVALID_REQUEST", "`scad` is required and must be a string."), 400);
    }
    if (!isNonEmptyString(candidate.base_revision)) {
      return c.json(errorBody("INVALID_REQUEST", "`base_revision` is required and must be a non-empty string."), 400);
    }
    if (
      candidate.discarded_params !== undefined &&
      (!Array.isArray(candidate.discarded_params) ||
        !candidate.discarded_params.every((name) => typeof name === "string"))
    ) {
      return c.json(errorBody("INVALID_REQUEST", "`discarded_params` must be an array of strings when provided."), 400);
    }

    try {
      const body: SourceResponse = await scadCore.updateSource(projectId, {
        scad: candidate.scad,
        base_revision: candidate.base_revision,
        discarded_params: candidate.discarded_params
      });
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
