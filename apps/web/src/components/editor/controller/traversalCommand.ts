// SPDX-License-Identifier: Apache-2.0

// S3-C C3 — client-side mirror of the server's undo/redo inverse derivation.
//
// The server (`applyEditorTraversal`) refuses with VALIDATION_FAILED unless
// the SUBMITTED command equals, by canonical JSON, the inverse it derives
// from the original accepted operation's before/after record. So the client
// must build the exact same inverse. This module mirrors
// `deriveTraversal` in `packages/scad-core/src/editor/commands.ts` (read-only
// reference; scad-core runtime code is deliberately NOT imported into the web
// app). Real-server agreement is verified by C5, not here.

import type { EditorCommand, EditorFeature, EditorTraversal } from "@scadforge/protocol";
import type { OperationEntry } from "./sessionLog.js";

/** Deep copy + deep freeze of plain JSON data, so a caller can never mutate what the log stores. */
export function cloneFrozen<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Stable (key-sorted) JSON — the comparison the server uses for "same command". */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * The exact command an undo or redo of `entry` must submit, or `null` when
 * the entry does not carry enough recorded data to derive it (for example a
 * `set-value` entry committed without a known before value). A `null` entry
 * is never traversable — the controller refuses locally rather than guess.
 * Mirrors `deriveTraversal` case for case.
 */
export function deriveTraversalCommand(entry: OperationEntry, direction: EditorTraversal["direction"]): EditorCommand | null {
  const forward = entry.command;
  const kind = forward?.kind ?? (entry.intent === "edit" ? "set-value" : null);
  const before: EditorFeature | null | undefined = entry.beforeFeature;

  if (kind === "set-value") {
    // Undo sets the before value, redo sets the after value.
    if (entry.beforeValue === null || entry.afterValue === null) return null;
    return {
      kind: "set-value",
      featureId: entry.featureId,
      bindingVersion: entry.bindingVersion,
      value: direction === "undo" ? entry.beforeValue : entry.afterValue
    };
  }

  if (forward?.kind === "put-feature") {
    const after = forward.feature;
    if (direction === "undo") {
      if (before === undefined) return null;
      // Undo of a create is a remove; undo of a replace restores the before-image exactly.
      return before === null
        ? { kind: "remove-feature", featureId: after.featureId, bindingVersion: after.bindingVersion }
        : { kind: "put-feature", feature: before };
    }
    // Redo restores the after-image exactly (create or replace).
    return { kind: "put-feature", feature: after };
  }

  if (forward?.kind === "remove-feature") {
    // A remove always records a before-image; without it the inverse is unknowable.
    if (!before) return null;
    return direction === "undo"
      ? { kind: "put-feature", feature: before }
      : { kind: "remove-feature", featureId: before.featureId, bindingVersion: before.bindingVersion };
  }

  return null;
}
