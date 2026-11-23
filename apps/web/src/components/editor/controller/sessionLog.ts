// SPDX-License-Identifier: Apache-2.0

// S3-C C3 — the session operation log and undo/redo cursor (spec §5.1–§5.3).
//
// Pure and dependency-free. One `SessionLog` belongs to one controller
// instance, so a reload or a new controller starts with an empty log
// (Q2: reload discards the log; history stays available through revert).
//
// Model: `entries[0..cursor)` are applied (undo walks backward from
// `cursor - 1`); `entries[cursor..)` is the redo stack. Only accepted
// `edit`/`setup` receipts are ever appended — an accepted undo/redo only moves
// the cursor, so there is no undo of an undo (Q5). `editorRevision` values are
// opaque hashes that can repeat (an undo may return to an earlier revision),
// so a revision is compared for equality against the tip but never used as an
// entry key.

import type { EditorCommand, EditorFeature, EditorReceipt, EditorTraversal } from "@scadforge/protocol";
import { cloneFrozen } from "./traversalCommand.js";

/** Spec §5.1, field for field, plus two optional extras the exact server inverse needs (see below). */
export interface OperationEntry {
  readonly operationId: string;
  readonly intent: "edit" | "setup";
  readonly baseEditorRevision: string;
  readonly editorRevision: string;
  readonly featureId: string;
  readonly bindingVersion: number;
  readonly beforeValue: number | null;
  readonly afterValue: number | null;
  /** `""` when the host never supplied the baseline digest (nothing is derived from it). */
  readonly beforeSidecarDigest: string;
  readonly afterSidecarDigest: string;
  readonly snapshotId: string;
  /** ISO-8601. */
  readonly acceptedAt: string;
  /** The forward command that was accepted. Needed to rebuild a `put-feature`/`remove-feature` inverse. */
  readonly command?: EditorCommand;
  /**
   * The feature as it was before this operation: `null` when the operation
   * created it, absent when the caller did not supply one (the entry is then
   * not traversable for the cases that need it).
   */
  readonly beforeFeature?: EditorFeature | null;
}

/** A log entry plus whether an external write has made it unreachable. */
export interface SessionLogEntry {
  readonly entry: OperationEntry;
  readonly stale: boolean;
}

/** Immutable read surface for the host (C4). A fresh object only when something changed. */
export interface SessionHistory {
  readonly entries: readonly SessionLogEntry[];
  /** Number of applied entries; `entries[cursor - 1]` is the next undo target. */
  readonly cursor: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoTarget: OperationEntry | null;
  readonly redoTarget: OperationEntry | null;
}

export type EntryDraft = Omit<OperationEntry, "baseEditorRevision" | "editorRevision" | "afterSidecarDigest" | "snapshotId" | "beforeSidecarDigest" | "acceptedAt">;

export class SessionLog {
  private entries: SessionLogEntry[] = [];
  private cursor = 0;
  /** Revision of the last receipt applied (edit, setup, undo OR redo), or the last baseline read. */
  private tipRevision: string | null = null;
  private tipSidecarDigest = "";
  /** Operation IDs of accepted undo/redo commits — never traversable. */
  private readonly traversalIds = new Set<string>();
  private cached: SessionHistory | null = null;

  history(): SessionHistory {
    if (this.cached) return this.cached;
    const entries = Object.freeze(this.entries.slice());
    const undo = this.cursor > 0 ? entries[this.cursor - 1] : undefined;
    const redo = this.cursor < entries.length ? entries[this.cursor] : undefined;
    this.cached = Object.freeze({
      entries,
      cursor: this.cursor,
      canUndo: undo !== undefined && !undo.stale,
      canRedo: redo !== undefined && !redo.stale,
      undoTarget: undo && !undo.stale ? undo.entry : null,
      redoTarget: redo && !redo.stale ? redo.entry : null
    });
    return this.cached;
  }

  get tip(): string | null {
    return this.tipRevision;
  }

  get sidecarDigest(): string {
    return this.tipSidecarDigest;
  }

  /** True for an operation ID that was an accepted undo/redo here — such an operation can never be traversed. */
  isTraversalOperation(operationId: string): boolean {
    return this.traversalIds.has(operationId);
  }

  /** The entry an undo/redo in `direction` would target, or `null` if there is none at the cursor. */
  target(direction: EditorTraversal["direction"]): SessionLogEntry | null {
    const index = direction === "undo" ? this.cursor - 1 : this.cursor;
    return index >= 0 && index < this.entries.length ? this.entries[index] : null;
  }

  /** Accepted fresh edit/setup: append, advance the cursor, clear redo. */
  appendFresh(draft: EntryDraft, receipt: EditorReceipt, acceptedAt: string): void {
    const entry: OperationEntry = cloneFrozen({
      ...draft,
      baseEditorRevision: receipt.baseEditorRevision,
      editorRevision: receipt.editorRevision,
      beforeSidecarDigest: this.tipSidecarDigest,
      afterSidecarDigest: receipt.sidecarDigest,
      snapshotId: receipt.snapshotId,
      acceptedAt
    });
    this.entries = [...this.entries.slice(0, this.cursor), { entry, stale: false }];
    this.cursor = this.entries.length;
    this.adoptTip(receipt);
    this.cached = null;
  }

  /**
   * Accepted undo/redo: move the cursor once and keep the rest of the stack.
   * The cursor only moves when the receipt's traversal still names the entry
   * at the cursor — a log invalidated or reset while the commit was in flight
   * leaves it where it is. The tip always follows the receipt (it IS the
   * document's new revision).
   */
  applyTraversal(traversal: EditorTraversal, receipt: EditorReceipt): boolean {
    this.traversalIds.add(receipt.operationId);
    const at = this.target(traversal.direction);
    let moved = false;
    if (at && at.entry.operationId === traversal.operationId) {
      this.cursor += traversal.direction === "undo" ? -1 : 1;
      moved = true;
    }
    this.adoptTip(receipt);
    this.cached = null;
    return moved;
  }

  /** Drop the redo stack (display failure; accepted fresh edit does this implicitly). */
  clearRedo(): void {
    if (this.cursor >= this.entries.length) return;
    this.entries = this.entries.slice(0, this.cursor);
    this.cached = null;
  }

  /**
   * The document cache reports a completed read at `revision`. A revision
   * different from the last receipt's means somebody else wrote: every entry
   * is stale (undo's server-side precondition can no longer hold) and redo is
   * cleared. Returns whether the tip moved (the host-visible history may have).
   */
  reconcileRevision(revision: string, sidecarDigest?: string): boolean {
    if (this.tipRevision === null) {
      this.tipRevision = revision;
      if (sidecarDigest !== undefined) this.tipSidecarDigest = sidecarDigest;
      return false;
    }
    if (revision === this.tipRevision) {
      if (sidecarDigest !== undefined && this.tipSidecarDigest === "") {
        this.tipSidecarDigest = sidecarDigest;
        this.cached = null;
      }
      return false;
    }
    this.invalidate();
    this.tipRevision = revision;
    this.tipSidecarDigest = sidecarDigest ?? "";
    this.cached = null;
    return true;
  }

  /** External write: mark every entry stale and clear redo. Returns whether anything changed. */
  invalidate(): boolean {
    const hadRedo = this.cursor < this.entries.length;
    const hadFresh = this.entries.some((e) => !e.stale);
    if (!hadRedo && !hadFresh) return false;
    this.entries = this.entries.slice(0, this.cursor).map((e) => (e.stale ? e : { entry: e.entry, stale: true }));
    this.cached = null;
    return true;
  }

  /** Project switch / dispose: the whole in-memory log goes (Q2 / spec §5.3 "Navigation/reload"). */
  reset(): boolean {
    const had = this.entries.length > 0 || this.tipRevision !== null || this.traversalIds.size > 0;
    this.entries = [];
    this.cursor = 0;
    this.tipRevision = null;
    this.tipSidecarDigest = "";
    this.traversalIds.clear();
    this.cached = null;
    return had;
  }

  private adoptTip(receipt: EditorReceipt): void {
    this.tipRevision = receipt.editorRevision;
    this.tipSidecarDigest = receipt.sidecarDigest;
  }
}
