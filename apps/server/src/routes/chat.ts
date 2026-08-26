// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request validation, turn-id/timestamp bookkeeping, the
// per-project concurrency policy, and SSE framing only. The turn itself runs
// entirely inside the injected `AgentProvider` (see services/agent-provider.ts
// for the event-ownership split between host and provider).
//
// Concurrency policy (counterexample: concurrent chat turns on one project):
// at most one turn may run per project at a time. A second `POST .../chat`
// while one is in flight gets a plain (non-SSE) `409 CONFLICT` — documented
// here since the frozen contract does not prescribe one.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { API_ROUTES } from "@scadforge/protocol";
import type { ChatImageInput, ChatTurnRequest, ParamValues, SseEvent } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import type { AgentProvider } from "../services/agent-provider.js";
import { errorBody, RouteError, toErrorResponse } from "../services/errors.js";
import { clampMaxPasses, isNonEmptyString, isSafeId } from "../services/validation.js";

export interface ChatRouteOptions {
  /** Default `max_passes` when the request omits an override (`SCADFORGE_MAX_PASSES`). */
  defaultMaxPasses: number;
}

function isChatImageInput(value: unknown): value is ChatImageInput {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ChatImageInput>;
  return (
    typeof candidate.data === "string" &&
    (candidate.mimeType === "image/png" || candidate.mimeType === "image/jpeg") &&
    (candidate.view === null || typeof candidate.view === "string") &&
    (candidate.camera === null || typeof candidate.camera === "string")
  );
}

function isParamValues(value: unknown): value is ParamValues {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createChatRoute(scadCore: ScadCoreApi, agent: AgentProvider, options: ChatRouteOptions) {
  const route = new Hono();
  /** Per-project turn lock — see the concurrency policy note above. */
  const busyProjects = new Set<string>();

  route.post(API_ROUTES.chat.turn, async (c) => {
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
    const candidate = payload as Partial<ChatTurnRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (!isNonEmptyString(candidate.message)) {
      return c.json(errorBody("INVALID_REQUEST", "`message` is required and must be a non-empty string."), 400);
    }
    if (candidate.images !== undefined && (!Array.isArray(candidate.images) || !candidate.images.every(isChatImageInput))) {
      return c.json(errorBody("INVALID_REQUEST", "`images` must be an array of valid image inputs."), 400);
    }
    if (candidate.params !== undefined && !isParamValues(candidate.params)) {
      return c.json(errorBody("INVALID_REQUEST", "`params` must be an object of parameter values."), 400);
    }
    if (candidate.max_passes !== undefined && typeof candidate.max_passes !== "number") {
      return c.json(errorBody("INVALID_REQUEST", "`max_passes` must be a number when provided."), 400);
    }

    // The project must exist before a stream (and a turn slot) is opened.
    try {
      await scadCore.getProject(projectId);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }

    if (busyProjects.has(projectId)) {
      return c.json(errorBody("CONFLICT", "A chat turn is already running for this project."), 409);
    }
    busyProjects.add(projectId);

    const turnId = randomUUID();
    const maxPasses = clampMaxPasses(candidate.max_passes, options.defaultMaxPasses);
    const message = candidate.message;
    const images = candidate.images ?? [];
    const params = candidate.params;

    return streamSSE(c, async (stream) => {
      let turnDoneSent = false;
      // Serializes writes: `AgentEventSink` is synchronous by contract, but
      // `stream.writeSSE` is async — a queue keeps frame order exact even if
      // a future provider fires events faster than the stream can flush.
      let writeChain: Promise<void> = Promise.resolve();
      const send = (event: SseEvent): void => {
        if (event.type === "turn_done") turnDoneSent = true;
        writeChain = writeChain.then(async () => {
          try {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          } catch {
            // Client disconnected mid-stream — nothing further to do; the
            // turn still runs to completion server-side but has no reader.
          }
        });
      };

      try {
        const startedAt = new Date().toISOString();
        send({ type: "turn_started", turn_id: turnId, project_id: projectId, max_passes: maxPasses, started_at: startedAt });

        const turnStartedMs = Date.now();
        try {
          await agent.runTurn({ projectId, turnId, message, images, params, maxPasses }, send);
        } catch (err) {
          // Unexpected provider crash (as opposed to an in-band failure the
          // provider itself reports as an `error` event): close the stream
          // cleanly instead of letting the rejection propagate.
          const code = err instanceof RouteError ? err.code : "AGENT_ERROR";
          const message = err instanceof Error ? err.message : "Agent turn failed unexpectedly.";
          send({ type: "error", turn_id: turnId, error_code: code, message });
        }

        if (!turnDoneSent) {
          send({
            type: "turn_done",
            turn_id: turnId,
            status: "error",
            passes_used: 0,
            summary: null,
            usage: null,
            duration_ms: Date.now() - turnStartedMs
          });
        }

        await writeChain;
      } finally {
        busyProjects.delete(projectId);
      }
    });
  });

  return route;
}
