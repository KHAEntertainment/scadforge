import { describe, expect, it } from "vitest";
import type { SseEvent } from "@scadforge/protocol";
import { parseSseStream, streamFromEvents } from "./sse.js";

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of parseSseStream(stream)) {
    out.push(event);
  }
  return out;
}

describe("parseSseStream", () => {
  it("parses a sequence of well-formed frames in order", async () => {
    const events: SseEvent[] = [
      { type: "turn_started", turn_id: "t1", project_id: "p1", max_passes: 2, started_at: "2026-08-26T00:00:00.000Z" },
      { type: "assistant_text", turn_id: "t1", text: "hello" },
      { type: "turn_done", turn_id: "t1", status: "completed", passes_used: 0, summary: null, usage: null, duration_ms: 10 }
    ];
    const parsed = await collect(streamFromEvents(events));
    expect(parsed).toEqual(events);
  });

  it("counterexample: a malformed frame mid-stream raises a typed parse error instead of silently dropping data", async () => {
    const encoder = new TextEncoder();
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: assistant_text\ndata: {"type":"assistant_text","turn_id":"t1","text":"ok"}\n\n'));
        controller.enqueue(encoder.encode("event: assistant_text\ndata: not json at all\n\n"));
        controller.close();
      }
    });

    await expect(collect(raw)).rejects.toThrow(/malformed/i);
  });

  it("stops yielding once the abort signal fires, without throwing", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(streamFromEvents([{ type: "assistant_text", turn_id: "t1", text: "x" }]));
    // streamFromEvents ignores signal itself; assert parseSseStream honors it directly.
    const generator = parseSseStream(streamFromEvents([{ type: "assistant_text", turn_id: "t1", text: "x" }]), controller.signal);
    const first = await generator.next();
    expect(first.done).toBe(true);
    expect(events.length).toBeGreaterThan(0); // sanity: non-aborted path still yields
  });
});
