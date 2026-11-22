// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation, the wire-byte-limit check and
// error-mapping only; everything else delegates to the injected
// `ScadCoreApi`.
//
// S3-B B5 (Issue #91) adds `POST …/editor/verify`. S3-B B6 (Issue #98) adds
// the remaining three: `GET …/editor`, `POST …/editor/commands`,
// `GET …/editor/operations/:operationId` — all in this SAME file, per
// `EDITOR_ROUTES`.

import { Hono } from "hono";
import {
  EDITOR_MAX_WIRE_BYTES,
  EDITOR_ROUTES,
  EditorProtocolError,
  parseEditorCommitRequest,
  parseEditorVerifyRequest
} from "@scadforge/protocol";
import type { EditorDocument, EditorOperationResponse, EditorProofResponse, EditorReceipt } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { isSafeId, isUuid } from "../services/validation.js";

export function createEditorRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.get(EDITOR_ROUTES.get, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }
    try {
      const body: EditorDocument = await scadCore.getEditorDocument(projectId);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

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

  route.post(EDITOR_ROUTES.commands, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }

    // Same pre-parse wire-limit discipline as `verify` above.
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

    // Step 1 of the ticket's ordered command flow: parse. An unparseable
    // request reserves nothing — `submitEditorCommand` never even sees it.
    let request;
    try {
      request = parseEditorCommitRequest(payload);
    } catch (err) {
      if (err instanceof EditorProtocolError) {
        return c.json(errorBody("INVALID_REQUEST", err.message), 400);
      }
      throw err;
    }

    try {
      const body: EditorReceipt = await scadCore.submitEditorCommand(projectId, request);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.get(EDITOR_ROUTES.operation, async (c) => {
    const projectId = c.req.param("projectId");
    const operationId = c.req.param("operationId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }
    if (!isUuid(operationId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid operation id."), 400);
    }
    try {
      const body: EditorOperationResponse = await scadCore.getEditorOperation(projectId, operationId);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
