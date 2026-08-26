// Parses the chat SSE stream into the frozen `SseEvent` union.
//
// Framing (packages/protocol/src/events.ts): each frame is
// `event: <type>\ndata: <JSON>\n\n`. We only trust the JSON body's own
// `type` discriminant to narrow the union — the `event:` line is read only
// to know when a frame is complete.

import { SSE_EVENT_TYPES, type SseEvent, type SseEventType } from "@scadforge/protocol";

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(SSE_EVENT_TYPES);

function isKnownEventType(value: unknown): value is SseEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/** Thrown when a frame's `data:` body is not valid JSON or lacks a known `type`. */
export class SseParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "SseParseError";
    this.raw = raw;
  }
}

function parseFrame(rawFrame: string): SseEvent | null {
  const dataLines = rawFrame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""));
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join("\n");
  if (dataText.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataText);
  } catch (cause) {
    throw new SseParseError(`Malformed SSE frame JSON: ${(cause as Error).message}`, dataText);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    !isKnownEventType((parsed as { type: unknown }).type)
  ) {
    throw new SseParseError("SSE frame missing a known event type discriminant", dataText);
  }

  return parsed as SseEvent;
}

/**
 * Reads a `ReadableStream<Uint8Array>` (e.g. `Response.body`) and yields each
 * complete `SseEvent` frame as it arrives, so the caller can render assistant
 * text progressively rather than waiting for the whole turn.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(rawFrame);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
    }
    // Flush a trailing frame with no terminating blank line.
    if (buffer.trim().length > 0) {
      const event = parseFrame(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Convenience for tests/fixtures: builds one raw SSE frame from an event object. */
export function encodeSseFrame(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Builds a `ReadableStream<Uint8Array>` from a list of events, for tests. */
export function streamFromEvents(events: SseEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeSseFrame(events[index])));
      index += 1;
    }
  });
}
