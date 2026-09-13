// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { parseEditorCommitRequest, parseEditorSidecar } from "@scadforge/protocol";
import type { EditorCommitRequest, EditorSidecar } from "@scadforge/protocol";
import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalSidecar,
  commandDigest,
  digest,
  editorRevision,
  requestDigest,
  sidecarDigest
} from "./canonical.js";
import fixtures from "./canonical.fixtures.json" with { type: "json" };

const HEX64_RE = /^[0-9a-f]{64}$/;

describe("canonicalJson (#72)", () => {
  it("is independent of object key insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(digest("scadforge-editor-command/1", { b: 1, a: 2 })).toBe(
      digest("scadforge-editor-command/1", { a: 2, b: 1 })
    );
  });

  it("sorts nested object keys recursively", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  it("preserves array element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ arr: [{ b: 1, a: 2 }, 3, 1] })).toBe('{"arr":[{"a":2,"b":1},3,1]}');
  });

  it("normalizes -0 to 0 in a Vec3-shaped array", () => {
    const vec3 = [1, -0, -3];
    expect(canonicalJson(vec3)).toBe("[1,0,-3]");
  });

  it("normalizes a bare -0 value to 0", () => {
    expect(canonicalJson(-0)).toBe("0");
  });

  it("throws on NaN anywhere in the value", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([1, Number.NaN])).toThrow(CanonicalJsonError);
  });

  it("throws on Infinity and -Infinity anywhere in the value", () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Number.NEGATIVE_INFINITY })).toThrow(CanonicalJsonError);
  });

  it("throws on undefined anywhere in the value, never silently dropping it", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([1, undefined, 2])).toThrow(CanonicalJsonError);
  });

  it("throws on functions, symbols and bigints", () => {
    expect(() => canonicalJson(() => {})).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Symbol("x"))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(10n)).toThrow(CanonicalJsonError);
  });

  it("throws on exotic objects (Date, Map, RegExp) instead of silently serializing them as {}", () => {
    // Object.keys(new Date()) is [] — without a plain-object guard these would
    // silently canonicalize as an empty object, discarding everything they
    // actually carry.
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(/x/)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ nested: new Date() })).toThrow(CanonicalJsonError);
  });

  it("accepts a null-prototype plain object", () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.a = 1;
    expect(canonicalJson(obj)).toBe('{"a":1}');
  });

  it("throws on a duplicate key in text input, rather than silently keeping the last occurrence", () => {
    expect(() => canonicalJson('{"a":1,"a":2}')).toThrow(CanonicalJsonError);
    // JSON.parse itself would silently accept this and keep the last "a".
    expect(() => JSON.parse('{"a":1,"a":2}')).not.toThrow();
  });

  it("detects a duplicate key nested inside an array of objects", () => {
    expect(() => canonicalJson('[{"a":1},{"b":1,"b":2}]')).toThrow(CanonicalJsonError);
  });

  it("does not falsely flag the same key repeated across separate sibling objects", () => {
    expect(() => canonicalJson('[{"a":1},{"a":2}]')).not.toThrow();
    expect(canonicalJson('[{"a":1},{"a":2}]')).toBe('[{"a":1},{"a":2}]');
  });

  it("canonicalizes valid JSON text (non-duplicate) the same as the equivalent parsed value", () => {
    expect(canonicalJson('{"b":1,"a":2}')).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it("throws on syntactically invalid JSON text", () => {
    expect(() => canonicalJson("{not json")).toThrow(CanonicalJsonError);
  });

  it("does not normalize Unicode: NFC and NFD forms of the same label produce different text and digests", () => {
    const nfc = "café"; // U+00E9 (precomposed é)
    const nfd = "café"; // "e" + U+0301 (combining acute accent)
    expect(nfc).not.toBe(nfd); // sanity: these are genuinely different code point sequences
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC")); // ...but normalize equal
    // Wrapped in an object: every real seam call site (sidecarDigest, editorRevision,
    // commandDigest, requestDigest) passes an object, never a bare top-level string —
    // a bare top-level string is text mode (see module header), not a string value.
    expect(canonicalJson({ label: nfc })).not.toBe(canonicalJson({ label: nfd }));
    expect(digest("scadforge-editor-sidecar/1", { label: nfc })).not.toBe(
      digest("scadforge-editor-sidecar/1", { label: nfd })
    );
  });

  it("preserves exact Unicode string content (only JSON-escapes control/quote/backslash)", () => {
    const s = 'héllo "world"\n';
    expect(canonicalJson({ s })).toBe(`{"s":${JSON.stringify(s)}}`);
  });

  it("treats a top-level string as raw JSON text to canonicalize, not a string value to quote", () => {
    // Documents the text-mode behavior: a bare top-level string must itself be
    // valid JSON text (e.g. an object/array literal), since no real call site in
    // this seam ever passes a bare label string as the top-level argument.
    expect(canonicalJson('{"b":1,"a":2}')).toBe('{"a":2,"b":1}');
    expect(() => canonicalJson("not json")).toThrow(CanonicalJsonError);
  });
});

describe("canonicalSidecar (#72)", () => {
  const fA: EditorSidecar["features"][number] = {
    featureId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    label: "Width",
    projectId: "11111111-1111-4111-8111-111111111111",
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "width", axis: "x", mapping: { scale: 1, offset: 0, anchor: "center" } }
  };
  const fB: EditorSidecar["features"][number] = {
    featureId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    label: "Bore",
    projectId: "11111111-1111-4111-8111-111111111111",
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: {
      kind: "radial",
      parameter: "bore_d",
      center: [0, 0, 0],
      axis: [0, 0, 1],
      parameterMeaning: "diameter",
      presentation: "diameter"
    }
  };

  it("sorts features by featureId regardless of input order", () => {
    const sidecar: EditorSidecar = { version: 1, features: [fA, fB] };
    const canonical = canonicalSidecar(sidecar);
    expect(canonical.features.map((f) => f.featureId)).toEqual([fB.featureId, fA.featureId]);
  });

  it("produces identical output regardless of input feature order", () => {
    const orderOne = canonicalSidecar({ version: 1, features: [fA, fB] });
    const orderTwo = canonicalSidecar({ version: 1, features: [fB, fA] });
    expect(canonicalJson(orderOne)).toBe(canonicalJson(orderTwo));
    expect(sidecarDigest({ version: 1, features: [fA, fB] })).toBe(sidecarDigest({ version: 1, features: [fB, fA] }));
  });

  it("leaves every other array (e.g. a radial binding's Vec3 fields) in its original order", () => {
    const sidecar: EditorSidecar = { version: 1, features: [fA, fB] };
    const canonical = canonicalSidecar(sidecar);
    const radial = canonical.features.find((f) => f.featureId === fB.featureId)!;
    expect(radial.binding).toMatchObject({ center: [0, 0, 0], axis: [0, 0, 1] });
  });
});

describe("digest (#72)", () => {
  it("produces a lowercase 64-hex digest", () => {
    const d = digest("scadforge-editor-sidecar/1", { version: 1, features: [] });
    expect(d).toMatch(HEX64_RE);
  });

  it("is deterministic for identical (domain, value) pairs", () => {
    expect(digest("scadforge-editor-command/1", { a: 1 })).toBe(digest("scadforge-editor-command/1", { a: 1 }));
  });

  it("differs across domains for identical canonical text (domain prefix prevents cross-purpose collisions)", () => {
    const value = { a: 1 };
    expect(digest("scadforge-editor-sidecar/1", value)).not.toBe(digest("scadforge-editor-revision/1", value));
  });

  it("hashes UTF-8 bytes of `${domain}\\n` + canonical text", () => {
    const value = { a: 1 };
    const expected = createHash("sha256")
      .update(`scadforge-editor-sidecar/1\n${canonicalJson(value)}`, "utf8")
      .digest("hex");
    expect(digest("scadforge-editor-sidecar/1", value)).toBe(expected);
  });
});

describe("editorRevision (#72)", () => {
  const sourceRevision = "a".repeat(64);
  const otherSourceRevision = "b".repeat(64);
  const sidecarA = sidecarDigest({ version: 1, features: [] });
  const sidecarB = sidecarDigest({
    version: 1,
    features: [
      {
        featureId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        label: "X",
        projectId: "11111111-1111-4111-8111-111111111111",
        createdAtRevision: "a".repeat(64),
        sourceFingerprint: "a".repeat(64),
        bindingVersion: 1,
        provenance: { kind: "manual" },
        binding: { kind: "linear", parameter: "x", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } }
      }
    ]
  });

  it("changes on a sidecar-only change while the source revision stays the same", () => {
    const before = editorRevision(sourceRevision, sidecarA);
    const after = editorRevision(sourceRevision, sidecarB);
    expect(before).not.toBe(after);
    // The caller's sourceRevision input is literally unchanged across the two calls.
  });

  it("changes on a source-only change while the sidecar digest stays the same", () => {
    const before = editorRevision(sourceRevision, sidecarA);
    const after = editorRevision(otherSourceRevision, sidecarA);
    expect(before).not.toBe(after);
  });

  it("produces a lowercase 64-hex digest", () => {
    expect(editorRevision(sourceRevision, sidecarA)).toMatch(HEX64_RE);
  });
});

describe("commandDigest and requestDigest (#72)", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const baseEditorRevision = "c".repeat(64);
  const command = {
    kind: "set-value" as const,
    featureId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    bindingVersion: 1,
    value: 42.5
  };
  const intent = "edit" as const;
  const traversal = null;

  function request(overrides: Partial<EditorCommitRequest> = {}): EditorCommitRequest & { projectId: string } {
    return {
      version: 1,
      baseEditorRevision,
      command,
      intent,
      traversal,
      operationId: "22222222-2222-4222-8222-222222222222",
      proofId: "33333333-3333-4333-8333-333333333333",
      ...overrides,
      projectId
    };
  }

  it("requestDigest is identical across requests differing only in operationId", () => {
    const a = requestDigest(request({ operationId: "22222222-2222-4222-8222-222222222222" }));
    const b = requestDigest(request({ operationId: "99999999-9999-4999-8999-999999999999" }));
    expect(a).toBe(b);
  });

  it("requestDigest differs across requests differing only in proofId", () => {
    const a = requestDigest(request({ proofId: "33333333-3333-4333-8333-333333333333" }));
    const b = requestDigest(request({ proofId: "44444444-4444-4444-8444-444444444444" }));
    expect(a).not.toBe(b);
  });

  it("commandDigest changes when version, projectId, baseEditorRevision, command, intent or traversal changes", () => {
    const base = commandDigest({ version: 1, projectId, baseEditorRevision, command, intent, traversal });
    expect(
      commandDigest({ version: 1, projectId: "99999999-9999-4999-8999-999999999999", baseEditorRevision, command, intent, traversal })
    ).not.toBe(base);
    expect(
      commandDigest({ version: 1, projectId, baseEditorRevision: "d".repeat(64), command, intent, traversal })
    ).not.toBe(base);
    expect(
      commandDigest({
        version: 1,
        projectId,
        baseEditorRevision,
        command: { ...command, value: 1 },
        intent,
        traversal
      })
    ).not.toBe(base);
    expect(
      commandDigest({ version: 1, projectId, baseEditorRevision, command, intent: "setup", traversal })
    ).not.toBe(base);
    expect(
      commandDigest({
        version: 1,
        projectId,
        baseEditorRevision,
        command,
        intent: "undo",
        traversal: { operationId: "22222222-2222-4222-8222-222222222222", direction: "undo" }
      })
    ).not.toBe(base);
  });

  it("commandDigest does not change when operationId or proofId change (they are not part of its input shape)", () => {
    const a = commandDigest({ version: 1, projectId, baseEditorRevision, command, intent, traversal });
    // Pass a structurally-wider object (a full EditorCommitRequest) — TypeScript's
    // excess-property check does not apply to a variable, so this proves
    // commandDigest picks its exact field set rather than serializing whatever
    // extra fields the caller's object happens to carry.
    const wide = request({ operationId: "99999999-9999-4999-8999-999999999999" });
    const b = commandDigest(wide);
    expect(a).toBe(b);
  });
});

describe("golden fixtures (#72)", () => {
  for (const fixture of fixtures.sidecars) {
    it(`sidecar fixture "${fixture.name}" reproduces its recorded canonical text and digest`, () => {
      const sidecar = fixture.input as EditorSidecar;
      expect(canonicalJson(canonicalSidecar(sidecar))).toBe(fixture.canonicalText);
      expect(sidecarDigest(sidecar)).toBe(fixture.digest);
    });

    it(`sidecar fixture "${fixture.name}" round-trips through parseEditorSidecar unchanged`, () => {
      const parsed = parseEditorSidecar(fixture.input);
      expect(parsed).toEqual(fixture.input);
    });
  }

  for (const fixture of fixtures.commitRequests) {
    it(`commitRequest fixture "${fixture.name}" reproduces its recorded command and request digests`, () => {
      const body = fixture.body as EditorCommitRequest;
      expect(
        commandDigest({
          version: body.version,
          projectId: fixture.projectId,
          baseEditorRevision: body.baseEditorRevision,
          command: body.command,
          intent: body.intent,
          traversal: body.traversal
        })
      ).toBe(fixture.commandDigest);
      expect(requestDigest({ ...body, projectId: fixture.projectId })).toBe(fixture.requestDigest);
    });

    it(`commitRequest fixture "${fixture.name}" round-trips through parseEditorCommitRequest unchanged`, () => {
      const parsed = parseEditorCommitRequest(fixture.body);
      expect(parsed).toEqual(fixture.body);
    });
  }
});
