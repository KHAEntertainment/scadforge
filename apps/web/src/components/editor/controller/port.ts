// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — the recording port (spec §10.2 Q1, ticket "Shared seams").
//
// The controller owns this port and reads it to decide transitions
// (`preview-pending → preview-ok` / `preview-failed`); it never infers state
// from WASM status events, which is what fixes Failures A and B. C4's
// preview adapter is the writer: a sample value plus a monotonic sample
// generation. A write whose generation does not strictly advance the port
// is ignored — it is a stale completion racing a fresher one.

export interface PortSample {
  value: number;
  generation: number;
}

export type PortReadState =
  | { status: "empty"; generation: number }
  | { status: "sample"; value: number; generation: number }
  | { status: "failed"; generation: number };

/** The writer half C4's preview adapter is handed. */
export interface TransactionPortWriter {
  /** Reports a confirmed sample. Ignored if `sample.generation` does not strictly advance the port. */
  write(sample: PortSample): void;
  /** Reports that rendering at `generation` failed or timed out. Ignored if stale. */
  fail(generation: number): void;
}

/** The reader half the controller uses internally. */
export interface TransactionPortReader {
  read(): PortReadState;
  subscribe(listener: () => void): () => void;
}

export class TransactionPort implements TransactionPortWriter, TransactionPortReader {
  private state: PortReadState = { status: "empty", generation: 0 };
  private readonly listeners = new Set<() => void>();

  read(): PortReadState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  write(sample: PortSample): void {
    if (sample.generation < this.state.generation) return; // stale completion
    if (sample.generation === this.state.generation && this.state.status !== "empty") return; // already resolved
    this.state = { status: "sample", value: sample.value, generation: sample.generation };
    this.notify();
  }

  fail(generation: number): void {
    if (generation < this.state.generation) return;
    if (generation === this.state.generation && this.state.status !== "empty") return;
    this.state = { status: "failed", generation };
    this.notify();
  }

  /** Reset to empty at a fresh generation — called when a new gesture begins. */
  reset(generation: number): void {
    this.state = { status: "empty", generation };
    // No notify: a reset is a controller-driven realignment, not a port event
    // the controller itself needs to react to.
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
