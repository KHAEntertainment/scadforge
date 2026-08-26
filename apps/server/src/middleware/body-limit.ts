// SPDX-License-Identifier: Apache-2.0
//
// A body-size guard that reports an oversized request through the frozen
// `{error_code, message}` vocabulary instead of Hono's default bare-text 413
// (there is no `ScadForgeErrorCode` with a 413 mapping — this closed union
// maps oversized-body to `INVALID_REQUEST`, same as any other malformed
// request). Wraps Hono's own `bodyLimit` middleware, which correctly streams
// and caps the body instead of trusting a caller-supplied `content-length`
// header (which most callers, including `fetch`, never set at all).

import type { MiddlewareHandler } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";
import { errorBody } from "../services/errors.js";

/**
 * Chat turns carry annotated-view PNGs (bare base64 in JSON), so the limit is
 * generous relative to a typical REST body but still bounded — an unbounded
 * body is a resource-exhaustion vector the process must survive.
 */
export const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024; // 20 MiB

export function bodySizeLimit(maxSize: number = MAX_REQUEST_BODY_BYTES): MiddlewareHandler {
  return honoBodyLimit({
    maxSize,
    onError: (c) => c.json(errorBody("INVALID_REQUEST", `Request body exceeds the ${maxSize}-byte limit.`), 400)
  });
}
