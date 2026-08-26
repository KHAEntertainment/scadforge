// SPDX-License-Identifier: Apache-2.0
//
// Builders for the MCP `CallToolResult` shapes the frozen contract describes.
// Kept separate from the handlers so `packages/mcp-server` (M4) can reuse them
// verbatim and inherit `TOOL_RESULT_RULES` for free.

import { ERROR_CODES } from "@scadforge/protocol";
import type { ScadForgeErrorCode } from "@scadforge/protocol";
import {
  IMAGE_LABEL_PREFIX,
  TOOL_RESULT_IMAGE_MIME_TYPE,
  type ToolCallResult,
  type ToolContentBlock,
  type ToolImageBlock,
  type ToolTextBlock
} from "./contract.js";

/** `content[0]`: a single `text` block of pure JSON. No prose, no fence. */
export function jsonBlock(payload: unknown): ToolTextBlock {
  return { type: "text", text: JSON.stringify(payload) };
}

/** The `view: <name>` label that MUST immediately precede each image block. */
export function imageLabelBlock(view: string): ToolTextBlock {
  return { type: "text", text: `${IMAGE_LABEL_PREFIX}${view}` };
}

/** An image block. `data` is BARE base64 — never a `data:` URI. */
export function imageBlock(base64: string): ToolImageBlock {
  return { type: "image", data: base64, mimeType: TOOL_RESULT_IMAGE_MIME_TYPE };
}

/**
 * Wrap content blocks as a tool result.
 *
 * `isError` is never set. `ToolCallResult.isError` is typed `false | undefined`
 * because an `isError: true` result has its `content` collapsed to a plain
 * string by the SDK, silently dropping every image block
 * (`TOOL_RESULT_RULES.neverIsErrorWithImages`). Failure is signalled by
 * `ok: false` inside `content[0]`'s JSON instead.
 */
export function toolResult(...content: ToolContentBlock[]): ToolCallResult {
  return { content };
}

/** A success result carrying only the JSON envelope. */
export function successResult(payload: Record<string, unknown>): ToolCallResult {
  return toolResult(jsonBlock(payload));
}

/** A failure result: `{ok:false, error_code, message}` plus any extra fields. */
export function failureResult(
  errorCode: ScadForgeErrorCode,
  message: string,
  extra: Record<string, unknown> = {}
): ToolCallResult {
  return toolResult(jsonBlock({ ok: false, error_code: errorCode, message, ...extra }));
}

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

/** True when `value` is a member of the frozen closed error vocabulary. */
export function isErrorCode(value: unknown): value is ScadForgeErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/**
 * Map a rejection from a {@link import("./scad-core-api.js").ScadCoreApi} onto
 * the closed error vocabulary.
 *
 * An implementation that rejects with `{error_code}` gets its code passed
 * straight through; a bare `Error` whose name or message says "timeout" /
 * "abort" is classified; everything else falls back to `fallback`.
 */
export function toErrorCode(error: unknown, fallback: ScadForgeErrorCode): ScadForgeErrorCode {
  if (error && typeof error === "object") {
    const code = (error as { error_code?: unknown }).error_code;
    if (isErrorCode(code)) return code;
    const name = String((error as { name?: unknown }).name ?? "");
    if (name === "AbortError") return "TURN_ABORTED";
    if (name === "TimeoutError") return "TIMEOUT";
  }
  const text = errorMessage(error).toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "TIMEOUT";
  return fallback;
}

/** A human-readable, single-line message for an unknown rejection value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * `TOOL_RESULT_RULES.filterStderr`: keep only `ERROR:` / `WARNING:` / `TRACE:`
 * lines, and return `null` — never `""` — when there is nothing to report.
 *
 * OpenSCAD prints ~10 lines of cache statistics on every invocation; passing
 * them through burns a few hundred tokens per render.
 */
export function filterStderr(stderr: string | null | undefined): string | null {
  if (!stderr) return null;
  const kept = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^\s*(ERROR|WARNING|TRACE):/.test(line));
  if (kept.length === 0) return null;
  return kept.join("\n");
}
