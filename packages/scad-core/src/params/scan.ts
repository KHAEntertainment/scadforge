// @scadforge/scad-core — Customizer parameter parser: top-level statement
// scanner.
//
// Recognizes exactly the Customizer-relevant top-level shapes (group-header
// comments, caption comments, literal variable declarations) and stops at
// the first top-level construct that is none of those — matching the real
// CLI's empirically-confirmed behavior: a module/function definition, a
// module call/geometry statement, `echo(...)`, etc. permanently ends
// Customizer scanning, while a non-literal-valued assignment (`x = a * 2;`)
// is silently skipped and scanning continues, and `include <...>` /
// `use <...>` directives are fully transparent (neither stop scanning nor
// count as a declaration).
//
// Deliberately NOT a full OpenSCAD grammar: brace/paren/bracket depth
// tracking plus quote-awareness is enough to correctly find top-level
// statement boundaries without parsing OpenSCAD expressions in general.
// Never throws — malformed/truncated input degrades to an early stop, which
// is exactly the array-of-parameters-found-so-far the caller wants.
//
// SPDX-License-Identifier: Apache-2.0

import { parseLiteral } from "./literal.js";
import type { ParsedLiteral } from "./literal.js";

interface CommentSpan {
  /** Index of the first character of the comment (`/` of `//` or `/*`). */
  start: number;
  /** Index just past the comment's last character. */
  end: number;
  /** Inner text, delimiters stripped, NOT yet trimmed. */
  text: string;
  kind: "line" | "block";
}

/** Comment/quote-aware pass: blanks every comment (preserving newlines) and records each one's span + text. */
function collectComments(source: string): { code: string; comments: CommentSpan[] } {
  const chars = source.split("");
  const comments: CommentSpan[] = [];
  let inString = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (inString) {
      if (c === "\\" && i + 1 < chars.length) {
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      i++;
      continue;
    }
    if (c === "/" && chars[i + 1] === "/") {
      const start = i;
      let j = i + 2;
      while (j < chars.length && chars[j] !== "\n") j++;
      comments.push({ start, end: j, text: chars.slice(start + 2, j).join(""), kind: "line" });
      for (let k = start; k < j; k++) chars[k] = " ";
      i = j;
      continue;
    }
    if (c === "/" && chars[i + 1] === "*") {
      const start = i;
      let j = i + 2;
      while (j < chars.length && !(chars[j] === "*" && chars[j + 1] === "/")) j++;
      const end = j < chars.length ? j + 2 : chars.length; // unterminated block comment -> runs to EOF, never throws
      comments.push({ start, end, text: chars.slice(start + 2, Math.min(j, chars.length)).join(""), kind: "block" });
      for (let k = start; k < end; k++) if (chars[k] !== "\n") chars[k] = " ";
      i = end;
      continue;
    }
    i++;
  }
  return { code: chars.join(""), comments };
}

/** Scans forward from `start` for the next top-level (paren/bracket-depth 0) `;` or `{`. Never throws. */
function scanStatementEnd(code: string, start: number): { end: number; kind: "semi" | "brace" | "eof" } {
  let depth = 0;
  let inString = false;
  let i = start;
  while (i < code.length) {
    const c = code[i];
    if (inString) {
      if (c === "\\" && i + 1 < code.length) {
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      i++;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth <= 0 && c === "{") return { end: i, kind: "brace" };
    else if (depth <= 0 && c === ";") return { end: i, kind: "semi" };
    i++;
  }
  return { end: code.length, kind: "eof" };
}

const IDENTIFIER_ASSIGNMENT_RE = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)\s*([\s\S]*)$/;
const GROUP_HEADER_RE = /^\[(.+)\]$/;
const INCLUDE_USE_RE = /^(include|use)\s*<[^>]*>\s*$/;

/** One recognized top-level event, in source order. */
export type ScanEvent =
  | { kind: "group"; name: string }
  | { kind: "caption"; text: string }
  | {
      kind: "decl";
      name: string;
      literal: ParsedLiteral;
      trailingComment: string | null;
    }
  | { kind: "skip" }
  | { kind: "stop" };

function lineEndOf(code: string, from: number): number {
  const idx = code.indexOf("\n", from);
  return idx === -1 ? code.length : idx;
}

function findCommentCovering(comments: readonly CommentSpan[], pos: number, lineEnd: number): CommentSpan | undefined {
  return comments.find((c) => c.start >= pos && c.start < lineEnd + 1);
}

/**
 * Walks `source` top-to-bottom, emitting {@link ScanEvent}s until either the
 * source is exhausted or a `"stop"` event is produced (the caller must not
 * look past it — matches the real CLI permanently ending Customizer scanning
 * at the first non-declaration top-level statement).
 */
export function scanTopLevel(source: string): ScanEvent[] {
  const { code, comments } = collectComments(source);
  const events: ScanEvent[] = [];
  let i = 0;

  while (i < code.length) {
    const lineEnd = lineEndOf(code, i);
    const restOfLine = code.slice(i, lineEnd);

    // Nothing but whitespace (and possibly a blanked-out comment) up to the
    // end of the line: either a genuinely blank line, or a comment alone on
    // its own line — a group header or caption candidate.
    if (restOfLine.trim().length === 0) {
      const comment = findCommentCovering(comments, i, lineEnd);
      if (comment) {
        const trimmed = comment.text.trim();
        const groupMatch = comment.kind === "block" ? GROUP_HEADER_RE.exec(trimmed) : null;
        if (groupMatch) {
          events.push({ kind: "group", name: groupMatch[1].trim() });
        } else if (trimmed.length > 0) {
          events.push({ kind: "caption", text: trimmed });
        }
        i = comment.end;
        continue;
      }
      i = lineEnd + 1;
      continue;
    }

    // `include <...>` / `use <...>` — transparent, never a declaration and
    // never a stop trigger (empirically confirmed).
    if (INCLUDE_USE_RE.test(restOfLine.trim())) {
      i = lineEnd + 1;
      continue;
    }

    const { end, kind } = scanStatementEnd(code, i);
    if (kind === "brace") {
      // Module/function definition or a control-flow block at top level —
      // permanently stop (empirically confirmed: everything after is
      // excluded, even further-legitimate-looking param declarations).
      events.push({ kind: "stop" });
      break;
    }

    const statementText = code.slice(i, end);
    const match = IDENTIFIER_ASSIGNMENT_RE.exec(statementText.trim());
    if (!match) {
      if (kind === "eof") {
        // Truncated/malformed trailing statement with no assignment shape:
        // nothing more to find. Never throw.
        break;
      }
      // Any other top-level statement shape (module/geometry call, echo,
      // assert, a bare expression, etc.) permanently stops scanning.
      events.push({ kind: "stop" });
      break;
    }

    const name = match[1];
    const rhsText = match[2];
    const literal = parseLiteral(rhsText);

    // Trailing same-line comment: only recognized when the rest of THIS
    // line (after the statement's terminator) is otherwise blank. Recomputed
    // against `end`'s own line (not the loop-start `lineEnd`) so a
    // multi-line RHS still finds the comment on the line the `;` is
    // actually on.
    let trailingComment: string | null = null;
    let consumedComment: CommentSpan | undefined;
    if (kind === "semi") {
      const statementLineEnd = lineEndOf(code, end);
      const afterSemi = end + 1;
      const restAfterSemi = code.slice(afterSemi, statementLineEnd);
      if (restAfterSemi.trim().length === 0) {
        consumedComment = findCommentCovering(comments, afterSemi, statementLineEnd);
        if (consumedComment) trailingComment = consumedComment.text;
      }
    }

    if (literal) {
      events.push({ kind: "decl", name, literal, trailingComment });
    } else {
      // Assignment-shaped but non-literal RHS (references another variable,
      // calls a function, etc.) — not Customizer-eligible. Empirically
      // confirmed the real CLI SKIPS this and keeps scanning, rather than
      // stopping (`derived = size * 2;` did not hide subsequent params).
      events.push({ kind: "skip" });
    }

    // Advance past whatever we just consumed. Critically: if a trailing
    // comment on this SAME line was already attached to this statement, jump
    // past it — otherwise the next loop iteration's "blank line" branch
    // would re-discover that same comment and spuriously re-emit it as a
    // stray caption for whatever declaration follows.
    if (kind === "eof") {
      i = code.length;
    } else if (consumedComment) {
      i = consumedComment.end;
    } else {
      i = end + 1;
    }
  }

  return events;
}
