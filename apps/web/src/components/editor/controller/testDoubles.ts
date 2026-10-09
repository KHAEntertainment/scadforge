// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — test doubles for the controller's injected dependencies.
//
// These are C2's OWN doubles, scoped to this ticket's tests. C1 delivers the
// shared fake editor client (the real `EditorClient` implementation's test
// double) separately under `apps/web/src/test/` once it lands; this file is
// not that — `FakeEditorClient` here implements C2's minimal seam
// (`types.ts`'s `EditorClient`), not `apiClient.ts`.

import type {
  BroadcastChannelFactory,
  BroadcastChannelLike,
  CommitOutcome,
  EditorClient,
  EditorCommitRequest,
  TimerLike,
  UuidSource
} from "./types.js";

// ── UUID source ──────────────────────────────────────────────────────────

export function createSequentialUuidSource(prefix = "op"): UuidSource {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

// ── timer ────────────────────────────────────────────────────────────────

/** Delegates to the global `setTimeout`/`clearTimeout` — vitest's fake timers patch these transparently. */
export function createRealTimer(): TimerLike {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
    clearTimeout: (handle) => clearTimeout(handle)
  };
}

// ── editor client ────────────────────────────────────────────────────────

interface RecordedCommit {
  projectId: string;
  request: EditorCommitRequest;
}

interface RecordedLookup {
  projectId: string;
  operationId: string;
}

/**
 * Scriptable fake for `EditorClient`. Each `commit`/`lookupOperation` call
 * consumes the next queued outcome for that method (FIFO); queuing fewer
 * outcomes than calls throws, which surfaces a test's wrong call count
 * immediately instead of hanging on an unresolved promise.
 */
export class FakeEditorClient implements EditorClient {
  readonly commits: RecordedCommit[] = [];
  readonly lookups: RecordedLookup[] = [];

  private commitQueue: CommitOutcome[] = [];
  private lookupQueue: CommitOutcome[] = [];

  queueCommitOutcome(outcome: CommitOutcome): this {
    this.commitQueue.push(outcome);
    return this;
  }

  queueLookupOutcome(outcome: CommitOutcome): this {
    this.lookupQueue.push(outcome);
    return this;
  }

  async commit(projectId: string, request: EditorCommitRequest): Promise<CommitOutcome> {
    this.commits.push({ projectId, request });
    const outcome = this.commitQueue.shift();
    if (!outcome) throw new Error("FakeEditorClient.commit called with no queued outcome");
    return outcome;
  }

  async lookupOperation(projectId: string, operationId: string): Promise<CommitOutcome> {
    this.lookups.push({ projectId, operationId });
    const outcome = this.lookupQueue.shift();
    if (!outcome) throw new Error("FakeEditorClient.lookupOperation called with no queued outcome");
    return outcome;
  }
}

// ── broadcast channel ────────────────────────────────────────────────────

class InMemoryBroadcastChannel implements BroadcastChannelLike {
  private listeners = new Set<(event: { data: unknown }) => void>();

  constructor(
    private readonly bus: Map<string, Set<InMemoryBroadcastChannel>>,
    private readonly name: string
  ) {
    let peers = this.bus.get(name);
    if (!peers) {
      peers = new Set();
      this.bus.set(name, peers);
    }
    peers.add(this);
  }

  postMessage(message: unknown): void {
    const peers = this.bus.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      // Real BroadcastChannel never delivers a tab's own message back to it.
      if (peer === this) continue;
      for (const listener of peer.listeners) listener({ data: message });
    }
  }

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.bus.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

/**
 * An in-process `BroadcastChannel` stand-in (jsdom may lack the real one).
 * Every channel opened through ONE returned factory for the SAME name shares
 * a bus, simulating peer tabs; channels from two different factory calls do
 * not see each other, simulating unrelated projects/sessions.
 */
export function createInMemoryBroadcastChannelFactory(): BroadcastChannelFactory {
  const bus = new Map<string, Set<InMemoryBroadcastChannel>>();
  return (name) => new InMemoryBroadcastChannel(bus, name);
}
