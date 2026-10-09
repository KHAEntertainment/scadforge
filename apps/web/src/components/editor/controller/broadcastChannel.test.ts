// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { SecondTabDetector } from "./broadcastChannel.js";
import { createInMemoryBroadcastChannelFactory } from "./testDoubles.js";

describe("SecondTabDetector", () => {
  it("announces 'opened' on construction", () => {
    const factory = createInMemoryBroadcastChannelFactory();
    const peerOnCommitted = vi.fn();
    // A peer tab opened first so we can observe what the tab under test announces.
    const received: unknown[] = [];
    const peerChannel = factory("scadforge-editor-project-1");
    peerChannel.addEventListener("message", (event) => received.push(event.data));

    new SecondTabDetector(factory, "project-1", peerOnCommitted);

    expect(received).toEqual([{ type: "opened" }]);
  });

  it("a peer's committed broadcast triggers the injected refresh callback", () => {
    const factory = createInMemoryBroadcastChannelFactory();
    const onPeerCommitted = vi.fn();
    new SecondTabDetector(factory, "project-1", onPeerCommitted);
    const peer = new SecondTabDetector(factory, "project-1", vi.fn());

    peer.announceCommitted("op-1");

    expect(onPeerCommitted).toHaveBeenCalledTimes(1);
  });

  it("does not react to its own announcement", () => {
    const factory = createInMemoryBroadcastChannelFactory();
    const onPeerCommitted = vi.fn();
    const detector = new SecondTabDetector(factory, "project-1", onPeerCommitted);

    detector.announceCommitted("op-1");

    expect(onPeerCommitted).not.toHaveBeenCalled();
  });

  it("a different project's channel does not cross-notify", () => {
    const factory = createInMemoryBroadcastChannelFactory();
    const onPeerCommitted = vi.fn();
    new SecondTabDetector(factory, "project-1", onPeerCommitted);
    const otherProject = new SecondTabDetector(factory, "project-2", vi.fn());

    otherProject.announceCommitted("op-1");

    expect(onPeerCommitted).not.toHaveBeenCalled();
  });

  it("close stops delivering further messages", () => {
    const factory = createInMemoryBroadcastChannelFactory();
    const onPeerCommitted = vi.fn();
    const detector = new SecondTabDetector(factory, "project-1", onPeerCommitted);
    const peer = new SecondTabDetector(factory, "project-1", vi.fn());
    detector.close();

    peer.announceCommitted("op-1");

    expect(onPeerCommitted).not.toHaveBeenCalled();
  });
});
