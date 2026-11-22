// @scadforge/scad-core — canonical identity for the S3 studio editor (Issue #72, S3-B B1).
//
// The pure identity layer every later S3-B ticket hashes against: canonical
// JSON, domain-prefixed SHA-256 digests, the sidecar digest, editor revision,
// and command/request digests. PR #71 froze the wire parsers in
// `@scadforge/protocol`'s `editor.ts` — those enforce `-0 → 0` and reject
// malformed shapes ON THE WIRE, but persisted/hashed canonical serialization
// is this module's job. Any divergence between the two makes every editor
// commit's digest fail; this module turns that divergence into a failing
// unit test (`canonical.test.ts`) instead of a production outage.
//
// Governing spec: wire-and-recovery §"Canonical identity and durable
// operation claims"
// (`epics/.../s3-s4-plan/s3-contract/wire-and-recovery/`).
//
// Canonical JSON rules (this module, NOT the wire parsers):
//   - Object keys are recursively sorted (UTF-16 code-unit order).
//   - Arrays preserve element order, EXCEPT a sidecar's `features`, which
//     `canonicalSidecar` sorts by `featureId` before serialization.
//   - Numbers use native ECMAScript Number-to-string (which already
//     normalizes `-0` to `"0"`); `NaN`/`±Infinity` throw rather than
//     silently becoming `null` the way `JSON.stringify` would.
//   - `undefined`, functions, symbols and bigints throw rather than being
///    silently dropped (object properties) or coerced to `null` (array
//     elements) the way `JSON.stringify` would.
//   - Strings are exact Unicode text — no normalization (NFC/NFD stay
//     distinct), so no implicit canonicalization can silently merge two
//     visually-identical but code-point-distinct labels.
//   - A top-level `string` argument is treated as raw JSON TEXT to
//     canonicalize (not a JSON string literal) and is checked for duplicate
//     object keys before being trusted — `JSON.parse` alone silently keeps
//     the last occurrence of a duplicate key, which is exactly the kind of
//     silent coercion this module exists to refuse. No call site in this
//     seam passes a bare string as a top-level value, so this mode only
//     matters for text arriving from outside the process (or, here, from
//     `canonical.test.ts`'s dedicated duplicate-key case).
//
// Digests are SHA-256 over the UTF-8 bytes of `${domain}\n` followed by the
// canonical text, lowercase 64-hex. Pure functions, no I/O — reading or
// writing the sidecar is B3's job; this module only ever receives already
// in-memory values.
//
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type {
  EditorCommand,
  EditorCommitRequest,
  EditorFeature,
  EditorIntent,
  EditorSidecar,
  EditorTraversal
} from "@scadforge/protocol";
import { normalizeLineEndings } from "../lf.js";

// ═════════════════════════════════════════════════════════════════════════════
// 1. Digest domains
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The closed set of versioned digest domains. Every digest is computed over
 * `${domain}\n` + canonical text, so bumping a domain version is how a future
 * ticket changes a digest's meaning without silently colliding with the old
 * one. `scadforge-editor-transaction/1` is reserved for B4 (staged roll-forward
 * transactions); this ticket does not produce one, but the union is the
 * shared seam frozen in the S3-B ticket story and must stay closed here.
 * `scadforge-source-fingerprint/1` (S3-B B7) is the one shared source
 * fingerprint domain — B5's proof records and B6's editor document consume
 * the same {@link sourceFingerprint} value B7 computes, so it lives here
 * rather than as a private per-caller hash.
 */
export type DigestDomain =
  | "scadforge-editor-sidecar/1"
  | "scadforge-editor-revision/1"
  | "scadforge-editor-command/1"
  | "scadforge-editor-request/1"
  | "scadforge-editor-transaction/1"
  | "scadforge-source-fingerprint/1";

// ═════════════════════════════════════════════════════════════════════════════
// 2. Canonical JSON error
// ═════════════════════════════════════════════════════════════════════════════

/** Thrown by {@link canonicalJson} whenever a value can't be canonicalized without silently dropping or coercing information. */
export class CanonicalJsonError extends Error {
  public override readonly name = "CanonicalJsonError";
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Canonical JSON serialization (value mode)
// ═════════════════════════════════════════════════════════════════════════════

/** True for `{}`/`Object.create(null)`-style plain objects; false for a Date, Map, Set, RegExp, or any class instance. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) {
    throw new CanonicalJsonError("undefined is not valid in canonical JSON");
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      const n = value as number;
      if (!Number.isFinite(n)) {
        throw new CanonicalJsonError(`non-finite number (${n}) is not valid in canonical JSON`);
      }
      // Native Number-to-string already normalizes -0 to "0" per the
      // ECMAScript ToString algorithm — no bespoke -0 handling needed, and no
      // divergence from what a downstream JSON.parse of this text would read
      // back as 0.
      return String(n);
    }
    case "string":
      // Exact Unicode text, no normalization. `JSON.stringify` on a string
      // only escapes control/quote/backslash characters — it does not touch
      // code points, so NFC and NFD forms of the same label serialize to
      // different (and correctly distinct) text.
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((item) => serializeValue(item)).join(",")}]`;
      }
      if (!isPlainObject(value)) {
        // A Date, Map, Set, RegExp or class instance has no own enumerable
        // keys of interest to us; serializing it via Object.keys would
        // silently produce "{}" and drop everything it actually carries.
        // None of this seam's typed inputs are ever exotic objects, but
        // refusing them here keeps that a checked invariant, not an
        // assumption.
        const ctorName = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
        throw new CanonicalJsonError(`${ctorName} is not a plain object or array and is not valid in canonical JSON`);
      }
      return serializeObject(value as Record<string, unknown>);
    default:
      // function, symbol, bigint — none are representable in canonical JSON;
      // silently dropping or stringifying one would be exactly the kind of
      // coercion this module exists to refuse.
      throw new CanonicalJsonError(`value of type ${typeof value} is not valid in canonical JSON`);
  }
}

function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts = keys.map((key) => {
    const v = obj[key];
    if (v === undefined) {
      // JSON.stringify would silently drop this key. Canonical JSON must
      // never drop information a caller handed it under a real key.
      throw new CanonicalJsonError(`property ${JSON.stringify(key)} is undefined; canonical JSON never drops keys`);
    }
    return `${JSON.stringify(key)}:${serializeValue(v)}`;
  });
  return `{${parts.join(",")}}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Duplicate-key detection (text mode only)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Walks already-`JSON.parse`-validated JSON text and throws if any single
 * object literal repeats a key. `JSON.parse` itself silently keeps the LAST
 * occurrence of a duplicate key — exactly the silent-coercion behavior this
 * module exists to refuse for text arriving from outside the process. This
 * walker only needs to handle syntactically valid JSON (the caller already
 * proved that with `JSON.parse` before calling this), so it doesn't attempt
 * to be a general-purpose recovering parser.
 */
function assertNoDuplicateJsonKeys(text: string): void {
  const n = text.length;
  let i = 0;

  function skipWhitespace(): void {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  }

  function parseString(): string {
    // Precondition: text[i] === '"'.
    let result = "";
    i++;
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        i++;
        return result;
      }
      if (ch === "\\") {
        const esc = text[i + 1];
        switch (esc) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "/":
            result += "/";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hex = text.slice(i + 2, i + 6);
            result += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            // Already validated by JSON.parse; unreachable in practice.
            result += esc ?? "";
        }
        i += 2;
        continue;
      }
      result += ch;
      i++;
    }
    throw new CanonicalJsonError("unterminated string in JSON text");
  }

  function parseValue(): void {
    skipWhitespace();
    const ch = text[i];
    if (ch === "{") {
      parseObject();
      return;
    }
    if (ch === "[") {
      parseArray();
      return;
    }
    if (ch === '"') {
      parseString();
      return;
    }
    // number / true / false / null — already validated by JSON.parse; just
    // skip to the next structural character.
    while (i < n && text[i] !== "," && text[i] !== "]" && text[i] !== "}" && !/\s/.test(text[i])) i++;
  }

  function parseArray(): void {
    i++; // consume '['
    skipWhitespace();
    if (text[i] === "]") {
      i++;
      return;
    }
    for (;;) {
      parseValue();
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      throw new CanonicalJsonError("malformed JSON array");
    }
  }

  function parseObject(): void {
    i++; // consume '{'
    skipWhitespace();
    const seen = new Set<string>();
    if (text[i] === "}") {
      i++;
      return;
    }
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') throw new CanonicalJsonError("expected object key");
      const key = parseString();
      if (seen.has(key)) {
        throw new CanonicalJsonError(`duplicate key ${JSON.stringify(key)} in JSON text`);
      }
      seen.add(key);
      skipWhitespace();
      if (text[i] !== ":") throw new CanonicalJsonError("expected ':' after object key");
      i++;
      parseValue();
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      throw new CanonicalJsonError("malformed JSON object");
    }
  }

  parseValue();
  skipWhitespace();
  if (i !== n) throw new CanonicalJsonError("unexpected trailing content in JSON text");
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. canonicalJson
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Serializes `value` to canonical JSON text: recursively sorted object keys,
 * array order preserved, `-0` normalized to `0`, exact Unicode strings (no
 * normalization). Throws on `NaN`, `±Infinity`, `undefined`, functions,
 * symbols and bigints anywhere in the value — never silently drops or
 * coerces them the way `JSON.stringify` does.
 *
 * A top-level `string` is treated as raw JSON TEXT to canonicalize (see the
 * module header) and additionally throws on a duplicate object key.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new CanonicalJsonError(
        `text input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    assertNoDuplicateJsonKeys(value);
    return serializeValue(parsed);
  }
  return serializeValue(value);
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. canonicalSidecar
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns a new `EditorSidecar` with `features` sorted by `featureId`
 * (UTF-16 code-unit order — `featureId`s are lowercase-hex UUIDs, so this is
 * a stable, deterministic total order). Every other array anywhere in a
 * feature (e.g. a `Vec3` binding component) is left untouched by
 * `canonicalJson`'s generic array-preserves-order rule; this function is the
 * ONLY place feature order itself is ever changed.
 */
export function canonicalSidecar(sidecar: EditorSidecar): EditorSidecar {
  const features: EditorFeature[] = [...sidecar.features].sort((a, b) =>
    a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0
  );
  return { version: sidecar.version, features };
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. digest and derived digests
// ═════════════════════════════════════════════════════════════════════════════

/**
 * SHA-256 hex digest (lowercase, 64 characters) over the UTF-8 bytes of
 * `${domain}\n` followed by `canonicalJson(value)`. The domain prefix keeps
 * digests computed for different purposes from ever colliding even if their
 * canonical text happened to match.
 */
export function digest(domain: DigestDomain, value: unknown): string {
  const text = canonicalJson(value);
  return createHash("sha256").update(`${domain}\n${text}`, "utf8").digest("hex");
}

/** The sidecar digest: `digest` of the sidecar's canonical (feature-sorted) form. */
export function sidecarDigest(sidecar: EditorSidecar): string {
  return digest("scadforge-editor-sidecar/1", canonicalSidecar(sidecar));
}

/**
 * The editor revision: a digest of the project's source revision (existing
 * `computeSourceRevision`, `store/revision.ts`) together with the sidecar
 * digest. A binding-only (sidecar) change changes the editor revision
 * without touching the source revision; a source-only change changes the
 * editor revision without needing any sidecar edit, since either input
 * changing changes the digest.
 */
export function editorRevision(sourceRevision: string, sidecarDigest: string): string {
  return digest("scadforge-editor-revision/1", { sourceRevision, sidecarDigest });
}

/**
 * The source fingerprint (S3-B B7): a digest of the project's `.scad` source
 * alone, LF-normalized first (existing `normalizeLineEndings`, Issue #40) so
 * a source that differs only by line-ending convention fingerprints
 * identically — matching how the store already treats CRLF/LF as the same
 * source everywhere else. The ONE shared implementation: B7's agent context,
 * B5's proof records and B6's editor document all consume this exact value,
 * never a private per-caller hash, so the three surfaces can never disagree
 * about whether a feature's binding still describes the current source.
 *
 * Wrapped in an object (`{ scad: ... }`) rather than passed as a bare string
 * to `digest`/`canonicalJson` — a top-level string argument to
 * `canonicalJson` is treated as raw JSON TEXT to canonicalize (see that
 * module's header), which is not what a `.scad` source string is.
 */
export function sourceFingerprint(scad: string): string {
  return digest("scadforge-source-fingerprint/1", { scad: normalizeLineEndings(scad) });
}

/** The exact shape `commandDigest` hashes — nothing else, regardless of what extra fields a caller's object may carry. */
export interface CommandDigestInput {
  version: 1;
  projectId: string;
  baseEditorRevision: string;
  command: EditorCommand;
  intent: EditorIntent;
  traversal: EditorTraversal | null;
}

/**
 * The proof's command digest: covers `version`, `projectId`,
 * `baseEditorRevision`, the complete typed `command`, `intent` and
 * `traversal` — and NOTHING else. The caller's object is destructured into a
 * fresh literal before serialization so a structurally-wider object (e.g. a
 * full `EditorCommitRequest` also carrying `operationId`/`proofId`, which
 * TypeScript's excess-property check does not reject for a variable) can
 * never leak extra fields into the digest.
 */
export function commandDigest(input: CommandDigestInput): string {
  const picked: CommandDigestInput = {
    version: input.version,
    projectId: input.projectId,
    baseEditorRevision: input.baseEditorRevision,
    command: input.command,
    intent: input.intent,
    traversal: input.traversal
  };
  return digest("scadforge-editor-command/1", picked);
}

/** The exact shape `requestDigest` hashes — `operationId` is deliberately excluded (it is the lookup key, not identity). */
export type RequestDigestInput = EditorCommitRequest & { projectId: string };

/**
 * The request digest: covers `version`, route `projectId`,
 * `baseEditorRevision`, the complete typed `command`, `proofId`, `intent`
 * and `traversal`. `operationId` is the durable claim's lookup key, not part
 * of its identity, and is excluded — two requests differing only in
 * `operationId` must hash identically so a retry of the exact same request
 * under a fresh id is still recognizable as the same request; two requests
 * differing only in `proofId` must hash differently, since a stale or
 * mismatched proof must not be silently accepted as the same commit.
 */
export function requestDigest(input: RequestDigestInput): string {
  const picked = {
    version: input.version,
    projectId: input.projectId,
    baseEditorRevision: input.baseEditorRevision,
    command: input.command,
    proofId: input.proofId,
    intent: input.intent,
    traversal: input.traversal
  };
  return digest("scadforge-editor-request/1", picked);
}
