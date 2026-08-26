// SPDX-License-Identifier: Apache-2.0
//
// The single place that maps a failure — thrown from a route handler, a
// `ScadCoreApi` implementation, or an `AgentProvider` — onto the frozen
// `{error_code, message}` body (PROJECT_CONTEXT.md "API spec"). No route file
// invents its own mapping (CLAUDE.md hard rule 3: no business logic in routes).

import { HTTP_STATUS_BY_ERROR_CODE } from "@scadforge/protocol";
import type { ApiError, ScadForgeErrorCode } from "@scadforge/protocol";

/**
 * Thrown by route handlers and service implementations to signal an expected,
 * typed failure (bad input, missing resource, a downstream tool/render
 * failure, ...). Anything else thrown (a plain `Error`, a programming bug) is
 * treated as `INTERNAL_ERROR` by {@link toErrorResponse} — the route layer
 * never crashes the process on either kind.
 */
export class RouteError extends Error {
  readonly code: ScadForgeErrorCode;

  constructor(code: ScadForgeErrorCode, message: string) {
    super(message);
    this.name = "RouteError";
    this.code = code;
  }
}

/** Builds the frozen error body. */
export function errorBody(code: ScadForgeErrorCode, message: string): ApiError {
  return { error_code: code, message };
}

/** The HTTP status a given error code maps to (frozen table). */
export function statusFor(code: ScadForgeErrorCode): number {
  return HTTP_STATUS_BY_ERROR_CODE[code];
}

/**
 * Normalizes anything caught in a route's try/catch (a {@link RouteError}, a
 * plain `Error`, or a non-Error throw) into a `{status, body}` pair ready to
 * hand to `c.json(...)`. Never re-throws — this is the last mile of the
 * "process never crashes on a failed render" requirement.
 */
export function toErrorResponse(err: unknown): { status: number; body: ApiError } {
  if (err instanceof RouteError) {
    return { status: statusFor(err.code), body: errorBody(err.code, err.message) };
  }
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  return { status: statusFor("INTERNAL_ERROR"), body: errorBody("INTERNAL_ERROR", message) };
}
