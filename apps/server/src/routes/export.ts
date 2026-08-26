// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation and error-mapping only. The validation
// gate itself (CLAUDE.md hard rule 7: `export` runs `validate_mesh` first and
// refuses without an explicit override) lives entirely in `ScadCoreApi`; this
// route only forwards the `allow_validation_failure` flag and surfaces the
// resulting `VALIDATION_FAILED` typed error when the gate refuses.

import { Hono } from "hono";
import { API_ROUTES, EXPORT_FORMATS } from "@scadforge/protocol";
import type { ExportRequest, ExportResponse } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, statusFor, toErrorResponse } from "../services/errors.js";
import { isSafeId } from "../services/validation.js";

function isExportFormat(value: unknown): value is ExportRequest["format"] {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

export function createExportRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.post(API_ROUTES.exports.create, async (c) => {
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
    const candidate = payload as Partial<ExportRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (!isExportFormat(candidate.format)) {
      return c.json(
        errorBody("UNSUPPORTED_FORMAT", `\`format\` must be one of ${EXPORT_FORMATS.join(", ")}.`),
        statusFor("UNSUPPORTED_FORMAT") as never
      );
    }
    if (candidate.allow_validation_failure !== undefined && typeof candidate.allow_validation_failure !== "boolean") {
      return c.json(errorBody("INVALID_REQUEST", "`allow_validation_failure` must be a boolean when provided."), 400);
    }

    try {
      const body: ExportResponse = await scadCore.runExport(projectId, {
        format: candidate.format,
        params: candidate.params,
        allow_validation_failure: candidate.allow_validation_failure ?? false
      });
      return c.json(body, 201);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.get(API_ROUTES.exports.file, async (c) => {
    const projectId = c.req.param("projectId");
    const file = c.req.param("file");
    if (!isSafeId(projectId) || !isSafeId(file)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id or export file name."), 400);
    }

    try {
      const exportFile = await scadCore.getExportFile(projectId, file);
      if (!exportFile) {
        return c.json(errorBody("NOT_FOUND", "Export file not found."), 404);
      }
      // See renders.ts for why this is a raw `Response` with a cast rather
      // than `c.body()`.
      return new Response(exportFile.data as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": exportFile.contentType, "Content-Length": String(exportFile.bytes) }
      });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
