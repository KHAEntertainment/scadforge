// Spike 3 — OpenSCAD CLI wrapper (syntax check / render / export).
// Standalone spike code. NOT product code, never imported by packages/*.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const OPENSCAD_BIN = process.env.SCADFORGE_OPENSCAD ?? 'openscad';

/** Fixed camera presets — SDP §6.2. gimbal: tx,ty,tz,rx,ry,rz,dist (dist ignored with --viewall). */
export const CAMERA_PRESETS = {
  iso: '0,0,0,55,0,25,0',
  front: '0,0,0,90,0,0,0',
  top: '0,0,0,0,0,0,0',
  right: '0,0,0,90,0,90,0',
};
export const DEFAULT_VIEWS = ['iso', 'front', 'right', 'section'];
export const DEFAULT_IMGSIZE = [512, 512];

/** OpenSCAD prints a cache/stat block on every run; keep only real diagnostics. */
export function diagnostics(stderr) {
  return `${stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(ERROR|WARNING|TRACE)[:\s]/i.test(l))
    .join('\n')
    .slice(0, 2000);
}

function run(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(OPENSCAD_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, ms: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut });
    });
  });
}

export async function openscadVersion() {
  const r = await run(['--version'], { timeoutMs: 15_000 });
  return `${r.stdout}${r.stderr}`.trim();
}

/**
 * Cheap syntax/eval check: export to .csg — full evaluation, no tessellation.
 * Returns { ok, errors[], warnings[], stderr, ms }.
 */
export async function syntaxCheck(scadPath, outDir) {
  const csg = path.join(outDir, 'syntaxcheck.csg');
  const r = await run([scadPath, '-o', csg], { timeoutMs: 60_000 });
  const lines = `${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    ok: r.code === 0,
    errors: lines.filter((l) => /^ERROR:/i.test(l)),
    warnings: lines.filter((l) => /^WARNING:/i.test(l)),
    stderr: diagnostics(r.stderr),
    ms: r.ms,
  };
}

/** Generate the section wrapper: model minus a half-space cube cut on Y at bbox center. */
async function writeSectionWrapper(scadPath, outDir) {
  const wrapper = path.join(outDir, '__section.scad');
  // Remove the y<0 half so the cut plane faces the iso camera (which looks along +y).
  const src = `// auto-generated section wrapper (spike 3)
CUT = 1000;
difference() {
  import_model();
  translate([-CUT/2, -CUT, -CUT/2]) cube([CUT, CUT, CUT]);
}
module import_model() { include <${path.basename(scadPath)}> }
`;
  await writeFile(wrapper, src, 'utf8');
  return wrapper;
}

/**
 * Render PNGs for the requested views.
 * Returns [{ view, path, bytes, ms, stderr, ok }]
 */
export async function renderViews(scadPath, outDir, views = DEFAULT_VIEWS, imgsize = DEFAULT_IMGSIZE) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const view of views) {
    const isSection = view === 'section';
    const src = isSection ? await writeSectionWrapper(scadPath, outDir) : scadPath;
    const camera = CAMERA_PRESETS[isSection ? 'iso' : view] ?? CAMERA_PRESETS.iso;
    const png = path.join(outDir, `${view}.png`);
    const r = await run(
      [
        src,
        '-o', png,
        '--camera=' + camera,
        '--viewall', '--autocenter',
        '--projection=o',
        '--imgsize=' + imgsize.join(','),
        '--colorscheme=Tomorrow',
        '--render', '',
      ],
      { timeoutMs: 180_000 },
    );
    let bytes = 0;
    try { bytes = (await stat(png)).size; } catch { /* not produced */ }
    results.push({
      view,
      path: png,
      bytes,
      ms: r.ms,
      ok: r.code === 0 && bytes > 0,
      stderr: diagnostics(r.stderr),
    });
  }
  return results;
}

/** Export binary STL for mesh validation. */
export async function exportStl(scadPath, outDir) {
  const stl = path.join(outDir, 'model.stl');
  const r = await run([scadPath, '-o', stl, '--export-format=binstl'], { timeoutMs: 180_000 });
  let bytes = 0;
  try { bytes = (await stat(stl)).size; } catch { /* not produced */ }
  return { ok: r.code === 0 && bytes > 0, path: stl, bytes, ms: r.ms, stderr: diagnostics(r.stderr) };
}

export async function readPngBase64(p) {
  const buf = await readFile(p);
  return buf.toString('base64');
}
