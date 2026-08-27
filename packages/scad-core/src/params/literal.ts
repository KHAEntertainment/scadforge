// @scadforge/scad-core — Customizer parameter parser: literal-expression parsing.
//
// OpenSCAD's Customizer only ever exposes a variable whose right-hand side is
// a LITERAL (a bare number/bool/string/vector-of-literals) — an assignment
// referencing another variable or calling a function is silently excluded by
// the real CLI (empirically confirmed against the pinned image: `derived =
// size * 2;` produces no schema entry, and scanning continues past it rather
// than stopping). This module recognizes exactly that literal grammar.
//
// SPDX-License-Identifier: Apache-2.0

import type { ParamType, ParamValue } from "../types.js";

/** The result of successfully parsing a literal expression. */
export interface ParsedLiteral {
  type: ParamType;
  value: ParamValue;
}

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** True iff `text` (already trimmed) is a bare numeric literal. */
export function isNumberLiteral(text: string): boolean {
  return NUMBER_RE.test(text);
}

/** Parses a bare numeric literal. Returns `undefined` if not one. */
export function parseNumberLiteral(text: string): number | undefined {
  const trimmed = text.trim();
  if (!isNumberLiteral(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parses a double-quoted OpenSCAD string literal (`"..."`, with `\"`, `\\`,
 * `\n`, `\t` escapes — the common subset). Returns `undefined` if `text`
 * (trimmed) isn't a single well-formed quoted string.
 */
export function parseStringLiteral(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') return undefined;
  const inner = trimmed.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") {
      const next = inner[i + 1];
      if (next === undefined) return undefined; // dangling escape — malformed
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        default:
          out += next;
      }
      i++;
    } else if (c === '"') {
      // An unescaped quote before the final char means this wasn't a single
      // clean literal (e.g. two adjacent strings) — malformed, reject.
      return undefined;
    } else {
      out += c;
    }
  }
  return out;
}

/** Splits `text` on top-level commas — respecting nested `[]`/`()`  and quoted strings. */
export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      current += c;
      if (c === "\\") {
        // consume the escaped char verbatim too, so an escaped quote doesn't
        // end the string early
        if (i + 1 < text.length) {
          current += text[i + 1];
          i++;
        }
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      current += c;
      continue;
    }
    if (c === "[" || c === "(") depth++;
    if (c === "]" || c === ")") depth--;
    if (depth === 0 && c === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/**
 * Parses a flat vector literal `[e1, e2, ...]` where every element is itself
 * a number/bool/string literal (no nesting, no expressions). Returns
 * `undefined` if `text` isn't a bracketed literal list at all (malformed or
 * an expression) — the caller decides how to surface that.
 *
 * Empirically, the real CLI infers `type: "number"` for a vector whose
 * elements are ALL numbers, and silently DROPS the parameter entirely when
 * any element is non-numeric (confirmed: `bool_vec = [true,false,true];` and
 * `str_vec = ["a","b"];` never appear in `--export-format=param` output).
 * We deliberately diverge here for robustness (CLAUDE.md hard rule 5 spirit —
 * never silently lose information the agent/UI could use): a non-numeric
 * vector is still surfaced, as `type: "vector"`. This divergence is
 * documented and exercised in `cross-check.docker.test.ts`.
 */
export function parseVectorLiteral(text: string): ParsedLiteral | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed[0] !== "[" || trimmed[trimmed.length - 1] !== "]") return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return undefined; // `[]` — not customizable, matches CLI (no type to infer)

  const rawElements = splitTopLevel(inner, ",").map((e) => e.trim());
  if (rawElements.some((e) => e.length === 0)) return undefined; // trailing/double comma — malformed

  const elements: ParamValue[] = [];
  let allNumbers = true;
  for (const raw of rawElements) {
    if (raw === "true" || raw === "false") {
      allNumbers = false;
      elements.push(raw === "true");
      continue;
    }
    const asString = parseStringLiteral(raw);
    if (asString !== undefined) {
      allNumbers = false;
      elements.push(asString);
      continue;
    }
    const asNumber = parseNumberLiteral(raw);
    if (asNumber !== undefined) {
      elements.push(asNumber);
      continue;
    }
    // A non-literal element (expression/identifier) makes the whole vector
    // non-literal — not customizable at all.
    return undefined;
  }

  if (allNumbers) {
    return { type: "number", value: elements as number[] };
  }
  // Mixed/non-numeric vector: surfaced as our own "vector" type (see doc
  // comment above) rather than silently dropped.
  if (elements.every((e) => typeof e === "boolean")) {
    return { type: "vector", value: elements as boolean[] };
  }
  if (elements.every((e) => typeof e === "string")) {
    return { type: "vector", value: elements as string[] };
  }
  // Genuinely mixed element types (e.g. [1, "a", true]) aren't a valid
  // ParamValue array shape either — OpenSCAD itself permits this at the
  // language level, but there is no meaningful ParamValue for it. Surface it
  // as a vector of stringified elements rather than throwing or dropping.
  return { type: "vector", value: elements.map((e) => String(e)) };
}

/**
 * Parses `text` (the trimmed source between `=` and the statement-terminating
 * `;`) as an OpenSCAD Customizer-eligible literal. Returns `undefined` when
 * it is not a literal (an expression, function call, identifier reference,
 * etc.) — the caller must then SKIP this declaration (not stop scanning;
 * empirically confirmed the real CLI keeps scanning past a non-literal
 * assignment).
 */
export function parseLiteral(text: string): ParsedLiteral | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "true") return { type: "boolean", value: true };
  if (trimmed === "false") return { type: "boolean", value: false };
  const asString = parseStringLiteral(trimmed);
  if (asString !== undefined) return { type: "string", value: asString };
  const asNumber = parseNumberLiteral(trimmed);
  if (asNumber !== undefined) return { type: "number", value: asNumber };
  if (trimmed[0] === "[") return parseVectorLiteral(trimmed);
  return undefined;
}
