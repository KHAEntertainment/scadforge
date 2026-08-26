// SPDX-License-Identifier: Apache-2.0
//
// Correlation between in-process tool handlers and the SDK's message stream.
//
// The provider learns a tool call's `tool_call_id` from the assistant's
// `tool_use` block, but only the handler knows the outcome that belongs in a
// `tool_result` SSE event (artifacts, wall-clock duration, image count). The
// handler records that here; the provider dequeues it when the matching
// `tool_result` block arrives. Calls to the same tool are answered in the order
// they were issued, so a per-tool FIFO is sufficient — including for the
// parallel tool calls the SDK may emit in one assistant response.

import type { ScadForgeErrorCode, ToolArtifact } from "@scadforge/protocol";
import type { ToolName } from "./contract.js";
import type { WriteRefusal } from "./pass-budget.js";

/** What one handler invocation produced. */
export interface ToolActivity {
  name: ToolName;
  /** The pass this call belonged to. */
  pass: number;
  ok: boolean;
  error_code: ScadForgeErrorCode | null;
  /** Short, UI-safe outcome line. Never contains `.scad` source. */
  summary: string | null;
  artifacts: ToolArtifact[];
  duration_ms: number;
  /** Image blocks returned to the model by this call. */
  images: number;
  /** Set on a refused `write_scad`, so the loop can label the turn correctly. */
  refusal?: WriteRefusal;
}

/** Per-pass rollup the provider folds into `PassUsage`. */
export interface PassActivity {
  toolCalls: number;
  images: number;
}

/** Collects {@link ToolActivity} for one turn. */
export class ToolActivityRecorder {
  /** Every activity, in the order the handlers completed. */
  readonly all: ToolActivity[] = [];

  private readonly queues = new Map<ToolName, ToolActivity[]>();
  private readonly byPass = new Map<number, PassActivity>();

  push(activity: ToolActivity): void {
    this.all.push(activity);
    const queue = this.queues.get(activity.name);
    if (queue) queue.push(activity);
    else this.queues.set(activity.name, [activity]);

    const rollup = this.byPass.get(activity.pass) ?? { toolCalls: 0, images: 0 };
    rollup.toolCalls += 1;
    rollup.images += activity.images;
    this.byPass.set(activity.pass, rollup);
  }

  /** Dequeue the oldest un-consumed activity for `name`. */
  take(name: ToolName): ToolActivity | undefined {
    return this.queues.get(name)?.shift();
  }

  /** Rollup for one pass; zeroes when the pass produced no tool calls. */
  pass(pass: number): PassActivity {
    return this.byPass.get(pass) ?? { toolCalls: 0, images: 0 };
  }

  /** Total image blocks delivered to the model this turn. */
  get images(): number {
    return this.all.reduce((total, activity) => total + activity.images, 0);
  }

  /** True when a `write_scad` was refused for the given reason. */
  hasRefusal(reason: WriteRefusal): boolean {
    return this.all.some((activity) => activity.refusal === reason);
  }
}
