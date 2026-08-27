// @scadforge/scad-core — typed error vocabulary for runtime failures.
//
// Every external call (OpenSCAD subprocess, filesystem, mesh parsing) is
// wrapped so it can only ever reject with a `ScadForgeError`, never an
// uncaught stack trace (PROJECT_CONTEXT.md "Error handling"; carries forward
// the QA finding from PR #7). The `{error_code, message}` shape is the SAME
// closed vocabulary as `@scadforge/protocol`'s `ApiError`.
//
// SPDX-License-Identifier: Apache-2.0

import type { ScadForgeErrorCode } from "@scadforge/protocol";

/** A typed, catchable ScadForge runtime failure. Never let one of these escape as a bare Error. */
export class ScadForgeError extends Error {
  readonly error_code: ScadForgeErrorCode;

  constructor(error_code: ScadForgeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ScadForgeError";
    this.error_code = error_code;
  }

  /** The plain `{error_code, message}` body — what actually crosses a tool/API boundary. */
  toPayload(): { error_code: ScadForgeErrorCode; message: string } {
    return { error_code: this.error_code, message: this.message };
  }

  static is(value: unknown): value is ScadForgeError {
    return value instanceof ScadForgeError;
  }

  /**
   * Normalizes ANY thrown value into a `ScadForgeError`, so a caller at a
   * tool/route boundary can always produce `{error_code, message}` and never
   * a raw stack trace. `fallbackCode` is used when `err` is not already a
   * `ScadForgeError`.
   */
  static normalize(err: unknown, fallbackCode: ScadForgeErrorCode, contextMessage?: string): ScadForgeError {
    if (ScadForgeError.is(err)) return err;
    const detail = err instanceof Error ? err.message : String(err);
    const message = contextMessage ? `${contextMessage}: ${detail}` : detail;
    return new ScadForgeError(fallbackCode, message, { cause: err });
  }
}

/** Runs `fn`, converting any thrown value into a `ScadForgeError` with `fallbackCode`. */
export async function withTypedError<T>(
  fn: () => Promise<T>,
  fallbackCode: ScadForgeErrorCode,
  contextMessage?: string
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw ScadForgeError.normalize(err, fallbackCode, contextMessage);
  }
}
