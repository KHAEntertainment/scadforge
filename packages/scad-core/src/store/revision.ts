// @scadforge/scad-core — the opaque source revision (Issue #54).
//
// The studio's editable Code tab saves against an OPAQUE revision of the
// project's coherent head+source+params state, so a save (or build) built on
// stale state is rejected as `CONFLICT` rather than silently force-overwriting
// newer edits. This module is the pure hash behind that revision; the caller
// (`apps/server`) owns the coherent read of head/`model.scad`/`params.json`
// and holds the cross-process params lock while doing it (`params-lock.ts`),
// because every writer of those three files already serializes on that lock.
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { SnapshotId } from "@scadforge/protocol";
import type { ParamValues } from "../types.js";

/** Recursively rebuilds a JSON value with object keys sorted, so hashing is independent of insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = canonicalize(obj[key]);
    return sorted;
  }
  return value;
}

/**
 * Computes the opaque source revision: a SHA-256 hex digest over the
 * project's coherent `head` + `model.scad` + `params.json` state. Parameter
 * keys are sorted before hashing, so two writes of the same logical params
 * bag hash identically regardless of key insertion order. Any change to any
 * of the three inputs — a new snapshot, an edited source, or a parameter
 * write (including a `snapshot:false` one) — changes the digest.
 */
export function computeSourceRevision(head: SnapshotId | null, scad: string, params: ParamValues): string {
  const payload = JSON.stringify(canonicalize({ head: head ?? null, scad, params }));
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
