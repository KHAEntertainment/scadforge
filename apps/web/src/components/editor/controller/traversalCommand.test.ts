// SPDX-License-Identifier: Apache-2.0

// Mirrors `deriveTraversal` in packages/scad-core/src/editor/commands.ts, one
// row per case. Agreement with the real server is verified by C5, not here.

import { describe, expect, it } from "vitest";
import type { EditorCommand, EditorFeature } from "@scadforge/protocol";
import type { OperationEntry } from "./sessionLog.js";
import { canonicalJson, cloneFrozen, deriveTraversalCommand } from "./traversalCommand.js";

function feature(featureId: string, bindingVersion: number, label = featureId): EditorFeature {
  return {
    featureId,
    label,
    projectId: "project-1",
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "width", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } }
  };
}

function entry(overrides: Partial<OperationEntry>): OperationEntry {
  return {
    operationId: "op-1",
    intent: "edit",
    baseEditorRevision: "a".repeat(64),
    editorRevision: "b".repeat(64),
    featureId: "feature-1",
    bindingVersion: 1,
    beforeValue: 40,
    afterValue: 43,
    beforeSidecarDigest: "",
    afterSidecarDigest: "c".repeat(64),
    snapshotId: "snap-1",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const CREATED = feature("feature-2", 3);
const BEFORE_IMAGE = feature("feature-2", 2, "before-image");
const AFTER_IMAGE = feature("feature-2", 3, "after-image");
const REMOVED = feature("feature-3", 4);

const ROWS: Array<{ name: string; entry: OperationEntry; direction: "undo" | "redo"; expected: EditorCommand }> = [
  {
    name: "set-value undo sets the before value",
    entry: entry({}),
    direction: "undo",
    expected: { kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 40 }
  },
  {
    name: "set-value redo sets the after value",
    entry: entry({}),
    direction: "redo",
    expected: { kind: "set-value", featureId: "feature-1", bindingVersion: 1, value: 43 }
  },
  {
    name: "put-feature create (before === null): undo is a remove at the after-image's binding version",
    entry: entry({
      intent: "setup",
      featureId: "feature-2",
      bindingVersion: 3,
      beforeValue: null,
      afterValue: null,
      command: { kind: "put-feature", feature: CREATED },
      beforeFeature: null
    }),
    direction: "undo",
    expected: { kind: "remove-feature", featureId: "feature-2", bindingVersion: 3 }
  },
  {
    name: "put-feature create: redo re-puts the after-image",
    entry: entry({
      intent: "setup",
      featureId: "feature-2",
      bindingVersion: 3,
      beforeValue: null,
      afterValue: null,
      command: { kind: "put-feature", feature: CREATED },
      beforeFeature: null
    }),
    direction: "redo",
    expected: { kind: "put-feature", feature: CREATED }
  },
  {
    name: "put-feature replace: undo restores the before-image exactly",
    entry: entry({
      intent: "setup",
      featureId: "feature-2",
      bindingVersion: 3,
      beforeValue: null,
      afterValue: null,
      command: { kind: "put-feature", feature: AFTER_IMAGE },
      beforeFeature: BEFORE_IMAGE
    }),
    direction: "undo",
    expected: { kind: "put-feature", feature: BEFORE_IMAGE }
  },
  {
    name: "put-feature replace: redo restores the after-image exactly",
    entry: entry({
      intent: "setup",
      featureId: "feature-2",
      bindingVersion: 3,
      beforeValue: null,
      afterValue: null,
      command: { kind: "put-feature", feature: AFTER_IMAGE },
      beforeFeature: BEFORE_IMAGE
    }),
    direction: "redo",
    expected: { kind: "put-feature", feature: AFTER_IMAGE }
  },
  {
    name: "remove-feature: undo restores the before-image exactly",
    entry: entry({
      intent: "setup",
      featureId: "feature-3",
      bindingVersion: 4,
      beforeValue: null,
      afterValue: null,
      command: { kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 },
      beforeFeature: REMOVED
    }),
    direction: "undo",
    expected: { kind: "put-feature", feature: REMOVED }
  },
  {
    name: "remove-feature: redo re-removes at the before-image's binding version",
    entry: entry({
      intent: "setup",
      featureId: "feature-3",
      bindingVersion: 4,
      beforeValue: null,
      afterValue: null,
      command: { kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 },
      beforeFeature: REMOVED
    }),
    direction: "redo",
    expected: { kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 }
  }
];

describe("deriveTraversalCommand (mirror of the server's deriveTraversal)", () => {
  it.each(ROWS)("$name", ({ entry: e, direction, expected }) => {
    expect(deriveTraversalCommand(e, direction)).toEqual(expected);
    // The server compares by canonical JSON, so key order must not matter either way.
    expect(canonicalJson(deriveTraversalCommand(e, direction))).toBe(canonicalJson(expected));
  });

  it.each([
    ["set-value without a before value", entry({ beforeValue: null }), "undo"],
    ["set-value without an after value", entry({ afterValue: null }), "redo"],
    ["put-feature undo without a recorded before-image", entry({ intent: "setup", command: { kind: "put-feature", feature: CREATED } }), "undo"],
    ["remove-feature without a recorded before-image", entry({ intent: "setup", command: { kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 } }), "undo"],
    ["remove-feature whose before-image is null", entry({ intent: "setup", command: { kind: "remove-feature", featureId: "feature-3", bindingVersion: 4 }, beforeFeature: null }), "redo"],
    ["a setup entry with no forward command", entry({ intent: "setup" }), "undo"]
  ] as const)("returns null (never guesses) for %s", (_name, e, direction) => {
    expect(deriveTraversalCommand(e, direction)).toBeNull();
  });
});

describe("cloneFrozen / canonicalJson", () => {
  it("deep-copies and deep-freezes, detaching from the caller's object", () => {
    const source = { a: { b: [1, { c: 2 }] } };
    const copy = cloneFrozen(source);
    source.a.b.push(3);
    expect(copy).toEqual({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(copy.a.b[1])).toBe(true);
    expect(Object.isFrozen(copy.a.b)).toBe(true);
  });

  it("canonicalJson sorts keys and ignores undefined properties", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: undefined } })).toBe(canonicalJson({ a: { d: 1 }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
