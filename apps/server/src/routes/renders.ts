// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation, path-traversal guards, and error-mapping
// only; everything else (including the PNG bytes) comes from the injected
// `ScadCoreApi`.

import { Hono } from "hono";
import { API_ROUTES, VIEW_NAMES } from "@scadforge/protocol";
import type { RenderViewsRequest, RenderViewsResponse } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { isSafeId, isViewName } from "../services/validation.js";

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function createRendersRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.post(API_ROUTES.renders.create, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }

    let payload: unknown = {};
    const rawBody = await c.req.text();
    if (rawBody.length > 0) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return c.json(errorBody("INVALID_REQUEST", "Request body must be valid JSON."), 400);
      }
    }
    const candidate = payload as Partial<RenderViewsRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (candidate.views !== undefined) {
      if (!Array.isArray(candidate.views) || candidate.views.length === 0 || !candidate.views.every(isViewName)) {
        return c.json(
          errorBody("INVALID_REQUEST", `\`views\` must be a non-empty array drawn from ${VIEW_NAMES.join(", ")}.`),
          400
        );
      }
    }
    if (candidate.imgsize !== undefined) {
      const size = candidate.imgsize;
      if (!Array.isArray(size) || size.length !== 2 || !size.every(isPositiveInt)) {
        return c.json(errorBody("INVALID_REQUEST", "`imgsize` must be `[width, height]` positive integers."), 400);
      }
    }

    try {
      const body: RenderViewsResponse = await scadCore.renderViews(projectId, {
        views: candidate.views,
        params: candidate.params,
        imgsize: candidate.imgsize
      });
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.get(API_ROUTES.renders.file, async (c) => {
    const projectId = c.req.param("projectId");
    const snapshotId = c.req.param("snapshotId");
    const view = c.req.param("view");
    if (!isSafeId(projectId) || !isSafeId(snapshotId) || !isViewName(view)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id, snapshot id, or view name."), 400);
    }

    try {
      const file = await scadCore.getSnapshotRenderFile(projectId, snapshotId, view);
      if (!file) {
        return c.json(errorBody("NOT_FOUND", "Render not found for that project/snapshot/view."), 404);
      }
      // Raw `Response`, not `c.body()`: `Uint8Array` is valid `BodyInit` at
      // runtime but the DOM lib's generic `Uint8Array<ArrayBufferLike>`
      // typing doesn't structurally match `BodyInit` under this TS/@types
      // combo — cast rather than fight the lib types for a value we already
      // know is safe to stream verbatim.
      return new Response(file.data as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": file.contentType, "Content-Length": String(file.bytes) }
      });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
