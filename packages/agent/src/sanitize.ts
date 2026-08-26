// SPDX-License-Identifier: Apache-2.0
//
// Host-side enforcement of CLAUDE.md hard rule 5 — "never paste full `.scad`
// into chat".
//
// Spike 3 §4.2 / docs/spikes/03-agent-loop/README.md: prompt-level instruction
// is NOT sufficient. When a pass was refused, haiku pasted the entire `.scad`
// source into its reply. The rule is therefore enforced here, on the host, on
// every `assistant_text` before it reaches the SSE stream, and on every
// free-text string a tool handler persists (snapshot messages).

/** Options for {@link stripFencedCodeBlocks}. */
export interface StripFencedCodeBlocksOptions {
  /**
   * Text substituted for each removed block. Defaults to the empty string — a
   * pure strip. Callers that want the reader to know something was removed can
   * pass {@link CODE_BLOCK_PLACEHOLDER}.
   */
  placeholder?: string;
}

/** A human-readable stand-in for a removed block. */
export const CODE_BLOCK_PLACEHOLDER = "[code omitted — see the Code tab]";

/**
 * A line that opens (or closes) a CommonMark fenced code block: at most three
 * leading spaces, then a run of three or more backticks or tildes.
 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Longest run of `char` anywhere in `text`. */
function longestRun(text: string, char: string): number {
  let best = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === char) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

/** True when `line` closes a fence opened with `fenceChar` × `openLength`. */
function closesFence(line: string, fenceChar: string, openLength: number): boolean {
  const match = FENCE_LINE.exec(line);
  if (!match) return false;
  if (match[1][0] !== fenceChar) return false;
  if (match[1].length < openLength) return false;
  // A closing fence may carry trailing whitespace and nothing else.
  return match[2].trim() === "";
}

/**
 * Remove every fenced code block from `text`.
 *
 * Handles the cases a model actually produces under pressure:
 * - ```` ``` ```` and `~~~` fences, with or without an info string
 * - **unterminated** fences (strip to the end of the text)
 * - **nested** fences (an inner ```` ``` ```` inside a ```` ```` ```` block does
 *   not close it — CommonMark requires the closing run to be at least as long
 *   as the opening one)
 * - a **one-line** fenced block
 *
 * Inline code spans in the middle of a sentence are left alone: they cannot
 * carry a whole `.scad` file, and removing them would mangle ordinary prose
 * about parameter names.
 */
export function stripFencedCodeBlocks(text: string, options: StripFencedCodeBlocksOptions = {}): string {
  return scanFences(text, options.placeholder ?? "").text;
}

/** Result of one fence scan. */
interface FenceScan {
  text: string;
  /** Number of fenced blocks removed. */
  removed: number;
}

function scanFences(text: string, placeholder: string): FenceScan {
  if (!text) return { text: "", removed: 0 };
  const lines = text.split("\n");
  const out: string[] = [];
  let removed = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = FENCE_LINE.exec(line);
    if (!match) {
      out.push(line);
      i += 1;
      continue;
    }

    const fenceChar = match[1][0];
    const openLength = match[1].length;
    const rest = match[2];
    const restRun = longestRun(rest, fenceChar);

    if (restRun >= openLength) {
      // Opener and closer on one line — a complete block.
      removed += 1;
      out.push(placeholder);
      i += 1;
      continue;
    }

    if (fenceChar === "`" && restRun > 0) {
      // A backtick fence's info string may not contain a backtick, so this is
      // not a fence at all. Leave it as prose.
      out.push(line);
      i += 1;
      continue;
    }

    // A real opening fence. Consume through its closer, or to the end of the
    // text when the model never closed it.
    let j = i + 1;
    while (j < lines.length && !closesFence(lines[j], fenceChar, openLength)) j += 1;
    removed += 1;
    out.push(placeholder);
    i = j < lines.length ? j + 1 : lines.length;
  }

  const joined = out
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: joined, removed };
}

/** True when `text` contains at least one fenced code block. */
export function containsFencedCodeBlock(text: string): boolean {
  return scanFences(text, "").removed > 0;
}

/**
 * Sanitize a chat-bound string: strip fenced blocks, trim, and clamp to
 * `maxLength` characters.
 *
 * Used for `assistant_text`, the `turn_done.summary` hand-back, snapshot
 * messages and `tool_call.input_summary` — every string that reaches a human
 * transcript.
 */
export function sanitizeChatText(text: string, maxLength?: number): string {
  const stripped = stripFencedCodeBlocks(text);
  if (maxLength === undefined || stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
