// SPDX-License-Identifier: Apache-2.0

// S3-C C3 — the per-project pending-receipt set (spec §5.5).
//
// When the user navigates away while a commit is `committing` or `resolving`,
// the controller records `{ projectId, operationId }` here. The set must
// outlive a controller instance (controllers are per project), so it is
// plain data in a store the host owns; the module-level default lives for the
// page, which also means a reload discards it (the operation itself stays
// durable server-side). It holds no controller or client references: whoever
// reconciles a record does so with its OWN project's client and view.

import type { EditorIntent, EditorTraversal } from "@scadforge/protocol";

export interface PendingReceiptRecord {
  readonly projectId: string;
  readonly operationId: string;
  readonly intent: EditorIntent;
  readonly traversal: EditorTraversal | null;
}

export interface PendingReceiptStore {
  /** Idempotent on `(projectId, operationId)`. Stores a copy. */
  record(record: PendingReceiptRecord): void;
  /** Copies of every record for exactly this project, never another's. */
  list(projectId: string): PendingReceiptRecord[];
  has(projectId: string, operationId: string): boolean;
  /** Returns whether a record was removed. */
  remove(projectId: string, operationId: string): boolean;
}

export function createPendingReceiptStore(): PendingReceiptStore {
  const byProject = new Map<string, Map<string, PendingReceiptRecord>>();
  return {
    record(record) {
      let operations = byProject.get(record.projectId);
      if (!operations) {
        operations = new Map();
        byProject.set(record.projectId, operations);
      }
      operations.set(record.operationId, {
        projectId: record.projectId,
        operationId: record.operationId,
        intent: record.intent,
        traversal: record.traversal ? { operationId: record.traversal.operationId, direction: record.traversal.direction } : null
      });
    },
    list(projectId) {
      return [...(byProject.get(projectId)?.values() ?? [])].map((r) => ({ ...r, traversal: r.traversal ? { ...r.traversal } : null }));
    },
    has(projectId, operationId) {
      return byProject.get(projectId)?.has(operationId) ?? false;
    },
    remove(projectId, operationId) {
      const operations = byProject.get(projectId);
      const removed = operations?.delete(operationId) ?? false;
      if (operations && operations.size === 0) byProject.delete(projectId);
      return removed;
    }
  };
}

/** Page-lifetime default. Tests inject their own via `createPendingReceiptStore()`. */
export const sharedPendingReceipts: PendingReceiptStore = createPendingReceiptStore();
