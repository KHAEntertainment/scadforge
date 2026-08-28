// SPDX-License-Identifier: Apache-2.0
//
// One route file per resource (CLAUDE.md hard rule 3). No business logic
// here — request-shape validation, path-traversal guards, and error-mapping
// only; everything else delegates to the injected `ScadCoreApi`.

import { Hono } from "hono";
import { API_ROUTES } from "@scadforge/protocol";
import type { ListSnapshotsResponse, RevertRequest, SnapshotDiffResponse, SnapshotResponse } from "@scadforge/protocol";
import type { ScadCoreApi } from "../services/scad-core-api.js";
import { errorBody, toErrorResponse } from "../services/errors.js";
import { SNAPSHOT_MESH_ROUTE } from "../services/urls.js";
import { isSafeId } from "../services/validation.js";

export function createSnapshotsRoute(scadCore: ScadCoreApi) {
  const route = new Hono();

  route.get(API_ROUTES.snapshots.list, async (c) => {
    const projectId = c.req.param("projectId");
    if (!isSafeId(projectId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project id."), 400);
    }
    try {
      const snapshots = await scadCore.listSnapshots(projectId);
      const body: ListSnapshotsResponse = { snapshots };
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.get(API_ROUTES.snapshots.get, async (c) => {
    const projectId = c.req.param("projectId");
    const snapshotId = c.req.param("snapshotId");
    if (!isSafeId(projectId) || !isSafeId(snapshotId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project or snapshot id."), 400);
    }
    try {
      const body: SnapshotResponse = await scadCore.getSnapshot(projectId, snapshotId);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.get(API_ROUTES.snapshots.diff, async (c) => {
    const projectId = c.req.param("projectId");
    const snapshotId = c.req.param("snapshotId");
    if (!isSafeId(projectId) || !isSafeId(snapshotId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project or snapshot id."), 400);
    }
    try {
      const body: SnapshotDiffResponse = await scadCore.getSnapshotDiff(projectId, snapshotId);
      return c.json(body);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  /**
   * `GET .../snapshots/:snapshotId/mesh` — the snapshot's binary STL, for the
   * three.js viewer (ScadForge Issue #41).
   *
   * Registered BEFORE the `revert` POST purely for readability; Hono matches
   * on method+path so ordering between them is not load-bearing. The path
   * template comes from `services/urls.ts` (see its note on why it is not in
   * the frozen `API_ROUTES`).
   *
   * A snapshot with no persisted mesh 404s. That is the expected answer for
   * any snapshot that was never validated — the viewer renders it as an
   * explanatory placeholder, not an error.
   */
  route.get(SNAPSHOT_MESH_ROUTE, async (c) => {
    const projectId = c.req.param("projectId");
    const snapshotId = c.req.param("snapshotId");
    if (!isSafeId(projectId) || !isSafeId(snapshotId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project or snapshot id."), 400);
    }

    try {
      const file = await scadCore.getSnapshotMeshFile(projectId, snapshotId);
      if (!file) {
        return c.json(errorBody("NOT_FOUND", "No mesh has been persisted for that snapshot."), 404);
      }
      // Same raw-`Response` treatment as the PNG route (see renders.ts for
      // why `c.body()` can't take this `Uint8Array` under the current types).
      return new Response(file.data as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": file.contentType, "Content-Length": String(file.bytes) }
      });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  route.post(API_ROUTES.snapshots.revert, async (c) => {
    const projectId = c.req.param("projectId");
    const snapshotId = c.req.param("snapshotId");
    if (!isSafeId(projectId) || !isSafeId(snapshotId)) {
      return c.json(errorBody("INVALID_REQUEST", "Invalid project or snapshot id."), 400);
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
    const candidate = payload as Partial<RevertRequest> | null;
    if (candidate === null || typeof candidate !== "object") {
      return c.json(errorBody("INVALID_REQUEST", "Request body must be a JSON object."), 400);
    }
    if (candidate.message !== undefined && typeof candidate.message !== "string") {
      return c.json(errorBody("INVALID_REQUEST", "`message` must be a string when provided."), 400);
    }

    try {
      const body: SnapshotResponse = await scadCore.revertSnapshot(projectId, snapshotId, {
        message: candidate.message
      });
      return c.json(body, 201);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as never);
    }
  });

  return route;
}
