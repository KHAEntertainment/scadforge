#!/usr/bin/env node
// Build script for the BOSL2/MCAD lookup index (Issue #19).
//
// Parses the vendored `.scad` sources under packages/libs/vendor/{bosl2,mcad}
// and writes a deterministic `packages/libs/generated/index.json` — the
// committed, build-time artifact `src/index.ts` loads synchronously at
// runtime (see that file's "Index acquisition" note for why committed was
// chosen over install-time generation).
//
// Usage:
//   node scripts/build-index.mjs
//
// Re-run and commit the result whenever the vendored sources are re-pinned.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const BOSL2_DIR = join(PACKAGE_ROOT, "vendor", "bosl2");
const MCAD_DIR = join(PACKAGE_ROOT, "vendor", "mcad");
const OUT_DIR = join(PACKAGE_ROOT, "generated");
const OUT_FILE = join(OUT_DIR, "index.json");

const NON_SOURCE_FILES = new Set(["LICENSE", "README.md"]);

function listScadFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".scad") && !NON_SOURCE_FILES.has(name))
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────
// BOSL2 — structured DocGen comment parser.
//
// BOSL2 source files use a documentation-comment convention (consumed
// upstream by its own docs generator): a run of `//`-prefixed lines
// immediately above a module/function/constant definition, opening with a
// `// Module: name()` / `// Function: name()` / `// Function&Module: name()`
// / `// Constant: name` header, followed by tagged subsections such as
// `// Synopsis:`, `// Usage:`, `// Description:`, `// Arguments:`,
// `// Example:` (see vendor/bosl2/screws.scad's `screw_hole()` block for a
// representative sample this parser was built against).
// ─────────────────────────────────────────────────────────────────────────

const BOSL2_HEADER_RE = /^\/\/ (Function&Module|Function|Module|Constant): (.+)$/;
// Any `// Tag Words:` line starts a new subsection within a doc block.
const BOSL2_TAG_RE = /^\/\/ ([A-Z][A-Za-z][A-Za-z &']*)(?:\([^)]*\))?:\s?(.*)$/;

const BOSL2_KIND_BY_HEADER = {
  Module: "module",
  Function: "function",
  "Function&Module": "function",
  Constant: "constant"
};

/** Extracts each file's default `include <BOSL2/...>` line(s) from its `// Includes:` block. */
function parseBosl2Includes(lines) {
  const idx = lines.findIndex((l) => l.trim() === "// Includes:");
  if (idx === -1) return "include <BOSL2/std.scad>";
  const includeLines = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\/\/\s+(include|use) <([^>]+)>$/);
    if (!m) break;
    includeLines.push(`${m[1]} <${m[2]}>`);
  }
  return includeLines.length > 0 ? includeLines.join("\n") : "include <BOSL2/std.scad>";
}

function stripCommentPrefix(line) {
  // "//   text" -> "text"; "//" (bare) -> ""
  return line.replace(/^\/\/\s?/, "");
}

function parseBosl2File(file) {
  const raw = readFileSync(join(BOSL2_DIR, file), "utf-8");
  const lines = raw.split("\n");
  const defaultInclude = parseBosl2Includes(lines);
  const symbols = [];

  let i = 0;
  while (i < lines.length) {
    const header = lines[i].match(BOSL2_HEADER_RE);
    if (!header) {
      i++;
      continue;
    }
    const kind = BOSL2_KIND_BY_HEADER[header[1]];
    const name = header[2].trim().replace(/\(\)$/, "");

    // Collect the full contiguous doc-comment block (this header's lines,
    // through the next non-"//" line).
    const blockLines = [];
    let j = i;
    while (j < lines.length && lines[j].startsWith("//")) {
      blockLines.push(lines[j]);
      j++;
    }

    // Split the block into tagged sections, IN ORDER, keeping repeated tags
    // (BOSL2 repeats both "// Usage: <title>" — one per call form — and
    // "// Example: <title>" — one per snippet) as separate entries rather
    // than merging same-named tags into one bucket, which would interleave
    // unrelated titles and code together.
    /** @type {{ tag: string, title: string, lines: string[] }[]} */
    const sections = [];
    let current = { tag: "Header", title: "", lines: [] };
    sections.push(current);
    for (const line of blockLines) {
      const tagMatch = line.match(BOSL2_TAG_RE);
      if (tagMatch) {
        current = { tag: tagMatch[1], title: tagMatch[2] ?? "", lines: [] };
        sections.push(current);
        continue;
      }
      current.lines.push(stripCommentPrefix(line));
    }

    const synopsis = sections
      .filter((s) => s.tag === "Synopsis")
      .flatMap((s) => s.lines)
      .join(" ")
      .trim();
    const description = sections
      .filter((s) => s.tag === "Description")
      .flatMap((s) => s.lines)
      .filter((l) => l.trim() !== "." && l.trim() !== "")
      .join(" ")
      .trim();
    const summary = (synopsis || description || `${name} (${kind}) from BOSL2's ${file}.`).slice(0, 240);

    // Each "// Usage: <title>" section holds only its own call form's code
    // lines; take the first non-empty code line (contains "(") from the
    // first Usage section as the representative signature.
    const usageSections = sections.filter((s) => s.tag === "Usage");
    const signature =
      usageSections.flatMap((s) => s.lines.map((l) => l.trim())).find((l) => l.includes("(")) ||
      (kind === "constant" ? name : `${name}(...)`);

    // Each "// Example: <title>" (or "Example(2D):", "Example(Med):", etc. —
    // the parenthesised render hint is stripped by BOSL2_TAG_RE) is its own
    // section; take up to 2, each capped short (contract: "short usage
    // snippets. Never a whole file").
    const examples = sections
      .filter((s) => s.tag === "Example")
      .slice(0, 2)
      .map((s) => {
        const code = s.lines.filter((l) => l.trim() !== "").slice(0, 6).join("\n").trim();
        return s.title && code ? `${s.title}\n${code}` : code || s.title;
      })
      .filter(Boolean);

    symbols.push({
      library: "BOSL2",
      name,
      kind,
      signature,
      file,
      summary,
      examples,
      include: defaultInclude
    });

    i = j;
  }

  return symbols;
}

// ─────────────────────────────────────────────────────────────────────────
// MCAD — plain top-level `module`/`function` declarations.
//
// MCAD predates any doc-comment convention: most files are bare
// `module name(...) { ... }` / `function name(...) = ...` declarations at
// column 0, occasionally preceded by a short `//` comment. This parser
// only picks up column-0 (non-indented) declarations, which excludes
// helper modules/functions nested inside another definition's braces.
// ─────────────────────────────────────────────────────────────────────────

const MCAD_DECL_RE = /^(module|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** Reads the full, possibly multi-line, parameter list starting at `(` on `lines[startLine]`. */
function readSignature(lines, startLine, parenColumn) {
  let depth = 0;
  let out = "";
  for (let li = startLine; li < lines.length; li++) {
    const text = li === startLine ? lines[li].slice(0) : lines[li];
    for (let ci = li === startLine ? 0 : 0; ci < text.length; ci++) {
      const ch = text[ci];
      if (li === startLine && ci < parenColumn) continue;
      out += ch;
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) return out.replace(/\s+/g, " ").trim();
      }
    }
    out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

function parseMcadFile(file) {
  const raw = readFileSync(join(MCAD_DIR, file), "utf-8");
  const lines = raw.split("\n");
  const symbols = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MCAD_DECL_RE);
    if (!m) continue;
    const [, keyword, name] = m;
    if (name.startsWith("test_") || name === "test") continue; // demo/test harness, not library API

    const parenColumn = lines[i].indexOf("(", m.index);
    const signature = `${name}${readSignature(lines, i, parenColumn)}`;

    // Immediately-preceding contiguous "//" comment lines (if any).
    const commentLines = [];
    for (let k = i - 1; k >= 0; k--) {
      const l = lines[k];
      if (l.startsWith("//")) {
        commentLines.unshift(stripCommentPrefix(l));
      } else if (l.trim() === "") {
        break;
      } else {
        break;
      }
    }
    const summary =
      commentLines.filter(Boolean).join(" ").trim().slice(0, 240) ||
      `${keyword === "module" ? "Module" : "Function"} from MCAD's ${file}.`;

    symbols.push({
      library: "MCAD",
      name,
      kind: keyword,
      signature,
      file,
      summary,
      examples: [],
      include: `use <MCAD/${file}>`
    });
  }

  return symbols;
}

function build() {
  const bosl2Symbols = listScadFiles(BOSL2_DIR).flatMap(parseBosl2File);
  const mcadSymbols = listScadFiles(MCAD_DIR).flatMap(parseMcadFile);

  const all = [...bosl2Symbols, ...mcadSymbols].sort((a, b) => {
    if (a.library !== b.library) return a.library.localeCompare(b.library);
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.name.localeCompare(b.name);
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(all, null, 2) + "\n", "utf-8");

  const byLibrary = all.reduce((acc, s) => {
    acc[s.library] = (acc[s.library] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Wrote ${all.length} symbols to ${OUT_FILE}`);
  console.log(byLibrary);
}

build();
