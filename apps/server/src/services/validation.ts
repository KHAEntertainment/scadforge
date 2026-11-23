// SPDX-License-Identifier: Apache-2.0
//
// Small, dependency-free request-shape guards shared by every route file.
// Kept deliberately minimal (no zod) — these are cheap shape checks, not the
// domain validation that belongs to `ScadCoreApi` implementations.

import { VIEW_NAMES } from "@scadforge/protocol";
import type { ViewName } from "@scadforge/protocol";

/**
 * A safe path segment for a project id, snapshot id, or export file name:
 * alphanumerics, `.`, `_`, `-` only, 1–128 chars, and never a `..` traversal
 * segment or a bare `.`/`..`. Rejects anything containing `/` or `\` outright
 * (the character class already excludes them, this is defense in depth).
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeId(id: string | undefined | null): id is string {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id === "." || id === "..") return false;
  if (id.includes("..") || id.includes("/") || id.includes("\\")) return false;
  return SAFE_ID_PATTERN.test(id);
}

export function isViewName(value: string | undefined | null): value is ViewName {
  return typeof value === "string" && (VIEW_NAMES as readonly string[]).includes(value);
}

/**
 * A UUID path segment (S3-B ticket B6: `GET .../editor/operations/:operationId`
 * validates this itself, before the request ever reaches `ScadCoreApi` —
 * `operationId`/`proofId`/`featureId` are server/client-minted UUIDs per the
 * wire-and-recovery contract, unlike `projectId`, which is a slug). Same
 * pattern `@scadforge/protocol`'s own (private) `expectUuid` uses.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(id: string | undefined | null): id is string {
  return typeof id === "string" && UUID_PATTERN.test(id);
}

/** Non-empty, trimmed string check for required text fields. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Clamps a caller-supplied `max_passes` override into a sane range. `0` is a
 * legal (if unusual) budget — it means "no self-correction, first pass only."
 * The upper bound is a defensive ceiling, not a contract value.
 */
const MAX_PASSES_CEILING = 10;

export function clampMaxPasses(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  const floored = Math.floor(requested);
  if (floored < 0) return 0;
  if (floored > MAX_PASSES_CEILING) return MAX_PASSES_CEILING;
  return floored;
}
