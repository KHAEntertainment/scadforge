// @scadforge/scad-core — path helpers for the frozen `.scadforge/` on-disk
// project layout (`@scadforge/protocol`'s `snapshot.ts`).
//
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { PROJECT_LAYOUT, SNAPSHOT_ID_PAD_WIDTH } from "@scadforge/protocol";
import type { SnapshotId } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";

export function metaDir(projectDir: string): string {
  return join(projectDir, PROJECT_LAYOUT.metaDir);
}

export function projectFilePath(projectDir: string): string {
  return join(metaDir(projectDir), PROJECT_LAYOUT.projectFile);
}

export function historyDir(projectDir: string): string {
  return join(metaDir(projectDir), PROJECT_LAYOUT.historyDir);
}

export function exportsDir(projectDir: string): string {
  return join(metaDir(projectDir), PROJECT_LAYOUT.exportsDir);
}

export function rootModelPath(projectDir: string): string {
  return join(projectDir, PROJECT_LAYOUT.modelFile);
}

export function rootParamsPath(projectDir: string): string {
  return join(projectDir, PROJECT_LAYOUT.paramsFile);
}

export function snapshotDir(projectDir: string, id: SnapshotId): string {
  return join(historyDir(projectDir), id);
}

/** Formats a 1-based snapshot sequence number as a zero-padded {@link SnapshotId}. */
export function formatSnapshotId(n: number): SnapshotId {
  const padded = String(n).padStart(SNAPSHOT_ID_PAD_WIDTH, "0");
  return padded;
}

/** Parses a {@link SnapshotId} back to its sequence number. Throws a typed error on a malformed id. */
export function parseSnapshotId(id: SnapshotId): number {
  const n = Number.parseInt(id, 10);
  if (!Number.isInteger(n) || n < 1 || !/^\d+$/.test(id)) {
    throw new ScadForgeError("INTERNAL_ERROR", `malformed snapshot id: '${id}'`);
  }
  return n;
}

/** The next {@link SnapshotId} after `current` (or the first, `"0001"`, when `current` is null). */
export function nextSnapshotId(current: SnapshotId | null): SnapshotId {
  if (current === null) return formatSnapshotId(1);
  return formatSnapshotId(parseSnapshotId(current) + 1);
}
