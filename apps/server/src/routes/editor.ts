// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation, the wire-byte-limit check and
// error-mapping only; everything else delegates to the injected
// `ScadCoreApi`.
//
// S3-B B5 (Issue #91) adds `POST …/editor/verify`. `EDITOR_ROUTES` declares
// three more handlers (`GET …/editor`, `POST …/editor/commands`,
// `GET …/editor/operations/:operationId`) that S3-B B6 adds to this SAME
// file — structured with that in mind, not one handler bolted onto
// `params.ts` or `projects.ts`.

import { Hono } from "hono";
import { EDITOR_MAX_WIRE_BYTES, EDITOR_ROUTES, EditorProtocolError, parseEditorVerifyRequest } from "@scadforge/protocol";
import type { EditorProofResponse } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { isSafeId } from "../services/validation.js";

export function createEditorRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.post(EDITOR_ROUTES.verify, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }

    // Enforced BEFORE parsing (ticket AC), as its own byte-length check on
    // the raw body — not `c.req.json()`, which would already have parsed
    // (and thus paid the cost of) an oversized payload by the time any size
    // could be observed. Below the global 20 MiB `bodySizeLimit()`
    // middleware (app.ts), which never fires for this route in practice
    // (1 MiB is always reached first) but still bounds the read itself.
    let raw: ArrayBuffer;
    try {
      raw = await c.req.arrayBuffer();
    } catch {
      return c.json(errorBody("INVALID_REQUEST", "Failed to read the request body."), 400);
    }
    if (raw.byteLength > EDITOR_MAX_WIRE_BYTES) {
      return c.json(errorBody("INVALID_REQUEST", `Request body exceeds the ${EDITOR_MAX_WIRE_BYTES}-byte limit.`), 400);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be valid JSON."), 400);
    }

    let request;
    try {
      request = parseEditorVerifyRequest(payload);
    } catch (err) {
      if (err instanceof EditorProtocolError) {
        return c.json(errorBody("INVALID_REQUEST", err.message), 400);
      }
      throw err;
    }

    try {
      const body: EditorProofResponse = await scadCore.verifyEditorCommand(projectId, request);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
