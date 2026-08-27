// @scadforge/scad-core — Customizer parameter parser: comment ANNOTATION
// parsing (`// [min:max]`, `// [min:step:max]`, `// [a, b, c]` value lists,
// `// [Label]` single-item lists, `// N` string length caps, plain-text
// captions).
//
// The specific rules below are grounded in ~6 empirical probes run against
// the real pinned OpenSCAD image (`sha256:0af06...b52fa7`,
// `--export-format=param`) rather than assumption — the CLI's actual
// comment grammar has several quirks the SDP/spike docs don't mention. Each
// rule cites the probe finding it came from. See also the module doc on
// `scan.ts` for how caption/annotation sources combine.
//
// SPDX-License-Identifier: Apache-2.0

import type { ParamOption, ParamValue } from "../types.js";
import { isNumberLiteral, parseStringLiteral, splitTopLevel } from "./literal.js";
import type { ParsedLiteral } from "./literal.js";

/** What a single trailing-comment annotation can contribute to a `ParamDefinition`. */
export interface AnnotationResult {
  caption?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  options?: ParamOption[];
}

const RANGE_STEP_RE = /^(-?(?:\d+\.?\d*|\.\d+))\s*:\s*(-?(?:\d+\.?\d*|\.\d+))\s*:\s*(-?(?:\d+\.?\d*|\.\d+))$/;
const RANGE_RE = /^(-?(?:\d+\.?\d*|\.\d+))\s*:\s*(-?(?:\d+\.?\d*|\.\d+))$/;
const BARE_INT_RE = /^\d+$/;

/** Verbatim caption from a preceding standalone `//` (or `/* *\/`) comment line — never interpreted. */
export function parsePrecedingCaption(commentText: string): string {
  return commentText.trim();
}

/**
 * Finds the matching `]` for the `[` at index 0 of `text`, honoring nested
 * `[]` and quoted strings (a `]` inside a quoted option label must not end
 * the bracket early). Returns `-1` if unbalanced (unclosed).
 */
function findMatchingBracket(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits `text` on the FIRST top-level `:` (quote-aware). Returns `[text]` if there is none. */
function splitFirstColon(text: string): [string] | [string, string] {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === ":") return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text];
}

/** Parses one option-list token (bare word, number, or quoted string) into a {@link ParamValue}. */
function parseOptionToken(raw: string): ParamValue {
  const trimmed = raw.trim();
  const asString = parseStringLiteral(trimmed);
  if (asString !== undefined) return asString;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (isNumberLiteral(trimmed)) return Number(trimmed);
  // Bare, unquoted word (e.g. `round`, `hex`) — Customizer permits this for
  // string-typed dropdowns; treat the raw text itself as the string value.
  return trimmed;
}

/** Loose equality for "is `initial` already one of `options`' values" (Probe: CLI auto-prepends `initial` when absent). */
function sameValue(a: ParamValue, b: ParamValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Parses the bracket's inner content (between `[` and `]`, exclusive) once isolated. Never throws. */
function parseBracketInner(inner: string, initial: ParamValue): AnnotationResult {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return {}; // `// []` — nothing to extract, still surfaces bare.

  const stepMatch = RANGE_STEP_RE.exec(trimmed);
  if (stepMatch) {
    const min = Number(stepMatch[1]);
    const step = Number(stepMatch[2]);
    const max = Number(stepMatch[3]);
    return normalizeRange(min, max, step);
  }
  const rangeMatch = RANGE_RE.exec(trimmed);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    return normalizeRange(min, max, 1);
  }

  // Not a numeric range — treat as an options (dropdown) list. Covers
  // `// [a, b, c]`, `// [1:One, 2:Two]`, and even a single bare token like
  // `// [Label]` (a length-1 list) — all empirically confirmed to produce an
  // `options` array on the real CLI, never a `caption`.
  const items = splitTopLevel(trimmed, ",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return {};

  const options: ParamOption[] = items.map((item) => {
    const [left, right] = splitFirstColon(item);
    if (right !== undefined) {
      const value = parseOptionToken(left);
      const label = right.trim();
      return { name: label.length > 0 ? label : String(value), value };
    }
    const value = parseOptionToken(left);
    return { name: String(value), value };
  });

  if (!options.some((o) => sameValue(o.value, initial))) {
    options.unshift({ name: String(initial), value: initial });
  }

  return { options };
}

/**
 * Reversed `min > max` is a real (if obscure) malformed case: the pinned CLI
 * collapses it to a degenerate `min === max === initial` (empirically
 * confirmed). We deliberately do NOT replicate that specific quirk — the AC
 * only requires OUR parser to have a documented, never-throwing fallback for
 * malformed input, not byte parity on this corner. Our fallback: swap so
 * `min <= max`, which is the more useful behavior for a slider UI. This
 * divergence is called out again in `cross-check.docker.test.ts`.
 */
function normalizeRange(min: number, max: number, step: number): AnnotationResult {
  const [lo, hi] = min <= max ? [min, max] : [max, min];
  return { min: lo, max: hi, step };
}

/**
 * Parses the trailing same-line comment on a Customizer declaration
 * (everything after `//` or inside a trailing `/* *\/`, already extracted by
 * the scanner). `initial` is the parsed literal value, needed for the
 * options auto-prepend rule. Never throws — a malformed annotation degrades
 * to `{}` (the bare parameter still surfaces; see `parse.ts`).
 */
export function parseTrailingAnnotation(commentText: string, initial: ParsedLiteral): AnnotationResult {
  const trimmed = commentText.trim();
  if (trimmed.length === 0) return {};

  if (trimmed[0] === "[") {
    const closeIdx = findMatchingBracket(trimmed);
    if (closeIdx === -1) return {}; // unclosed bracket — drop entirely, never throw (empirically confirmed CLI behavior).
    const inner = trimmed.slice(1, closeIdx);
    // Empirically, ANY non-whitespace content after the closing bracket is
    // ignored (not appended to a caption) — matches the CLI's observed
    // behavior of treating the bracket as the entire annotation.
    return parseBracketInner(inner, initial.value);
  }

  if (trimmed.includes("[")) {
    // Prose before a bracket that isn't the very first character —
    // empirically confirmed (3 variants: no space / one space / tab before
    // the bracket) to make the CLI drop the ENTIRE trailing annotation, not
    // just the unparsed prefix. We replicate this exactly since it is
    // consistent and well-confirmed.
    return {};
  }

  if (initial.type === "string" && BARE_INT_RE.test(trimmed)) {
    return { maxLength: Number(trimmed) };
  }

  return { caption: trimmed };
}
