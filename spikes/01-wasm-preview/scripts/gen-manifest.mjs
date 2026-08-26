// THROWAWAY spike script (Issue #3).
// Walks public/libraries/BOSL2 and writes public/libraries/manifest.json,
// a flat list of relative file paths the worker fetches and writes into
// the Emscripten virtual FS. Real BOSL2 source is vendored under
// public/libraries/BOSL2/ (from https://github.com/BelfrySCAD/BOSL2, BSD-2-Clause).
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "public", "libraries");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".scad")) {
      out.push(relative(ROOT, full).split("\\").join("/"));
    }
  }
  return out;
}

const files = walk(join(ROOT, "BOSL2")).sort();
writeFileSync(join(ROOT, "manifest.json"), JSON.stringify({ files }, null, 2));
console.log(`Wrote manifest.json with ${files.length} BOSL2 files`);
