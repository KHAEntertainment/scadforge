// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — second-tab detection primitive (spec §10.2 Q4, amended: "no tab
// locking... the controller detects a second tab on the same project (for
// example with BroadcastChannel keyed by projectId)").
//
// This module owns only the wire-level announce/listen. The notice UI is
// #70, out of scope here. `BroadcastChannel` may be absent in the jsdom test
// environment, so the factory is injected (`TransactionControllerDeps.
// broadcastChannelFactory`) rather than constructed with the global.

import type { BroadcastChannelFactory, BroadcastChannelLike } from "./types.js";

export type PeerMessage = { type: "opened" } | { type: "committed"; operationId: string };

function isPeerMessage(data: unknown): data is PeerMessage {
  if (typeof data !== "object" || data === null) return false;
  const type = (data as { type?: unknown }).type;
  if (type === "opened") return true;
  if (type === "committed") return typeof (data as { operationId?: unknown }).operationId === "string";
  return false;
}

/** The default factory: the real global `BroadcastChannel`, when present. */
export const defaultBroadcastChannelFactory: BroadcastChannelFactory = (name) => {
  if (typeof BroadcastChannel === "undefined") {
    throw new Error("BroadcastChannel is not available in this environment");
  }
  return new BroadcastChannel(name) as unknown as BroadcastChannelLike;
};

export class SecondTabDetector {
  private readonly channel: BroadcastChannelLike;
  private readonly listener: (event: { data: unknown }) => void;

  constructor(
    factory: BroadcastChannelFactory,
    projectId: string,
    private readonly onPeerCommitted: () => void
  ) {
    this.channel = factory(`scadforge-editor-${projectId}`);
    this.listener = (event) => {
      if (!isPeerMessage(event.data)) return;
      if (event.data.type === "committed") this.onPeerCommitted();
    };
    this.channel.addEventListener("message", this.listener);
    this.channel.postMessage({ type: "opened" } satisfies PeerMessage);
  }

  announceCommitted(operationId: string): void {
    this.channel.postMessage({ type: "committed", operationId } satisfies PeerMessage);
  }

  close(): void {
    this.channel.removeEventListener("message", this.listener);
    this.channel.close();
  }
}
