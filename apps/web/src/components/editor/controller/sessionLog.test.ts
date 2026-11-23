// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { EditorReceipt } from "@scadforge/protocol";
import { SessionLog, type EntryDraft } from "./sessionLog.js";

const rev = (c: string): string => c.repeat(64);

function receipt(operationId: string, base: string, revision: string): EditorReceipt {
  return {
    version: 1,
    projectId: "p1",
    operationId,
    requestDigest: rev("d"),
    baseEditorRevision: base,
    editorRevision: revision,
    snapshotId: `snap-${operationId}`,
    values: {},
    sidecarDigest: `digest-${operationId}`
  };
}

function draft(operationId: string, before: number, after: number): EntryDraft {
  return {
    operationId,
    intent: "edit",
    featureId: "f1",
    bindingVersion: 1,
    beforeValue: before,
    afterValue: after,
    command: { kind: "set-value", featureId: "f1", bindingVersion: 1, value: after }
  };
}

function appended(log: SessionLog, id: string, base: string, revision: string, before = 1, after = 2): void {
  log.appendFresh(draft(id, before, after), receipt(id, base, revision), "2026-01-01T00:00:00.000Z");
}

describe("SessionLog", () => {
  it("starts empty with nothing to undo or redo", () => {
    const h = new SessionLog().history();
    expect(h).toMatchObject({ cursor: 0, canUndo: false, canRedo: false, undoTarget: null, redoTarget: null });
    expect(h.entries).toHaveLength(0);
  });

  it("builds spec §5.1 entries from the receipt and carries the previous digest forward", () => {
    const log = new SessionLog();
    log.reconcileRevision(rev("a"), "baseline-digest");
    appended(log, "op-1", rev("a"), rev("b"));
    appended(log, "op-2", rev("b"), rev("c"));

    const [first, second] = log.history().entries.map((e) => e.entry);
    expect(first).toMatchObject({
      operationId: "op-1",
      intent: "edit",
      baseEditorRevision: rev("a"),
      editorRevision: rev("b"),
      beforeSidecarDigest: "baseline-digest",
      afterSidecarDigest: "digest-op-1",
      snapshotId: "snap-op-1",
      acceptedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(second.beforeSidecarDigest).toBe("digest-op-1");
  });

  it("walks the cursor with undo/redo and keeps the stack; a fresh append truncates redo", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));
    appended(log, "op-2", rev("b"), rev("c"));

    expect(log.applyTraversal({ operationId: "op-2", direction: "undo" }, receipt("op-3", rev("c"), rev("d")))).toBe(true);
    expect(log.history()).toMatchObject({ cursor: 1, canUndo: true, canRedo: true });
    expect(log.applyTraversal({ operationId: "op-2", direction: "redo" }, receipt("op-4", rev("d"), rev("e")))).toBe(true);
    expect(log.history()).toMatchObject({ cursor: 2, canRedo: false });

    log.applyTraversal({ operationId: "op-2", direction: "undo" }, receipt("op-5", rev("e"), rev("f")));
    appended(log, "op-6", rev("f"), rev("1"));
    expect(log.history().entries.map((e) => e.entry.operationId)).toEqual(["op-1", "op-6"]);
    expect(log.history().canRedo).toBe(false);
  });

  it("never appends a traversal and remembers traversal operation IDs", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));
    log.applyTraversal({ operationId: "op-1", direction: "undo" }, receipt("op-2", rev("b"), rev("c")));

    expect(log.history().entries).toHaveLength(1);
    expect(log.isTraversalOperation("op-2")).toBe(true);
    expect(log.isTraversalOperation("op-1")).toBe(false);
  });

  it("does not move the cursor when the traversal no longer names the entry at the cursor, but follows the receipt's revision", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));

    expect(log.applyTraversal({ operationId: "op-other", direction: "undo" }, receipt("op-2", rev("b"), rev("c")))).toBe(false);
    expect(log.history().cursor).toBe(1);
    expect(log.tip).toBe(rev("c"));
  });

  it("clearRedo drops only the redo side", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));
    appended(log, "op-2", rev("b"), rev("c"));
    log.applyTraversal({ operationId: "op-2", direction: "undo" }, receipt("op-3", rev("c"), rev("d")));

    log.clearRedo();

    expect(log.history()).toMatchObject({ cursor: 1, canUndo: true, canRedo: false });
    expect(log.history().entries).toHaveLength(1);
  });

  it("reconcileRevision: baseline, equal revision and a different revision (external write)", () => {
    const log = new SessionLog();
    expect(log.reconcileRevision(rev("a"))).toBe(false); // first read sets the baseline
    appended(log, "op-1", rev("a"), rev("b"));
    expect(log.reconcileRevision(rev("b"))).toBe(false); // our own receipt, coherent
    expect(log.history().canUndo).toBe(true);

    expect(log.reconcileRevision(rev("c"))).toBe(true); // somebody else wrote
    expect(log.history()).toMatchObject({ cursor: 1, canUndo: false, canRedo: false });
    expect(log.history().entries.every((e) => e.stale)).toBe(true);
    expect(log.reconcileRevision(rev("c"))).toBe(false);
  });

  it("entries appended after an invalidation are fresh again, and a stale entry blocks undo past it", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));
    log.reconcileRevision(rev("c"));
    appended(log, "op-2", rev("c"), rev("d"));

    expect(log.history().entries.map((e) => e.stale)).toEqual([true, false]);
    expect(log.history().canUndo).toBe(true);
    log.applyTraversal({ operationId: "op-2", direction: "undo" }, receipt("op-3", rev("d"), rev("e")));
    expect(log.history()).toMatchObject({ cursor: 1, canUndo: false, canRedo: true });
  });

  it("revisions that repeat are never used as entry keys", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));
    log.applyTraversal({ operationId: "op-1", direction: "undo" }, receipt("op-2", rev("b"), rev("a"))); // back on a

    expect(log.reconcileRevision(rev("a"))).toBe(false);
    expect(log.history()).toMatchObject({ cursor: 0, canRedo: true });
  });

  it("history() is stable until a change, and frozen", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));
    const h = log.history();
    expect(log.history()).toBe(h);
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.entries)).toBe(true);
    expect(Object.isFrozen(h.entries[0].entry)).toBe(true);
    log.clearRedo(); // nothing to clear
    expect(log.history()).toBe(h);
  });

  it("reset discards everything, including the traversal IDs", () => {
    const log = new SessionLog();
    appended(log, "op-1", rev("a"), rev("b"));
    log.applyTraversal({ operationId: "op-1", direction: "undo" }, receipt("op-2", rev("b"), rev("c")));

    expect(log.reset()).toBe(true);

    expect(log.history().entries).toHaveLength(0);
    expect(log.tip).toBeNull();
    expect(log.isTraversalOperation("op-2")).toBe(false);
    expect(log.reset()).toBe(false);
  });
});
