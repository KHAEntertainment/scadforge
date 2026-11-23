// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createPendingReceiptStore, sharedPendingReceipts } from "./pendingReceipts.js";

describe("PendingReceiptStore", () => {
  it("keeps records per project and never returns another project's", () => {
    const store = createPendingReceiptStore();
    store.record({ projectId: "p1", operationId: "op-1", intent: "edit", traversal: null });
    store.record({ projectId: "p2", operationId: "op-2", intent: "undo", traversal: { operationId: "op-1", direction: "undo" } });

    expect(store.list("p1").map((r) => r.operationId)).toEqual(["op-1"]);
    expect(store.list("p2").map((r) => r.operationId)).toEqual(["op-2"]);
    expect(store.list("p3")).toEqual([]);
    expect(store.has("p1", "op-2")).toBe(false);
  });

  it("is idempotent on (projectId, operationId) and removable", () => {
    const store = createPendingReceiptStore();
    const record = { projectId: "p1", operationId: "op-1", intent: "edit" as const, traversal: null };
    store.record(record);
    store.record(record);
    expect(store.list("p1")).toHaveLength(1);
    expect(store.remove("p1", "op-1")).toBe(true);
    expect(store.remove("p1", "op-1")).toBe(false);
    expect(store.list("p1")).toEqual([]);
  });

  it("holds plain copies: mutating the input or a listed record changes nothing stored", () => {
    const store = createPendingReceiptStore();
    const traversal = { operationId: "op-1", direction: "undo" as const };
    store.record({ projectId: "p1", operationId: "op-2", intent: "undo", traversal });
    traversal.operationId = "mutated";
    const listed = store.list("p1");
    (listed[0] as { operationId: string }).operationId = "mutated";

    expect(store.list("p1")).toEqual([{ projectId: "p1", operationId: "op-2", intent: "undo", traversal: { operationId: "op-1", direction: "undo" } }]);
  });

  it("two stores are independent, and a shared default exists for the page", () => {
    const a = createPendingReceiptStore();
    const b = createPendingReceiptStore();
    a.record({ projectId: "p1", operationId: "op-1", intent: "edit", traversal: null });
    expect(b.list("p1")).toEqual([]);
    expect(sharedPendingReceipts.list("never-recorded")).toEqual([]);
  });
});
