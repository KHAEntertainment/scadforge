#!/usr/bin/env node
// Spike 3 — Claude Agent SDK write_scad -> render_views -> validate_mesh -> fix loop.
//
//   node loop.mjs "a 20mm cube with a 5mm centered hole"
//   node loop.mjs --probe                 # prove image tool-results reach the model
//   node loop.mjs --seed-defect           # deterministic render-only-defect fixture
//   SCADFORGE_MAX_PASSES=2 node loop.mjs "a cup with a handle"
//
// Standalone spike. Not part of the pnpm workspace; never imported by product code.
import { createSdkMcpServer, tool, query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  syntaxCheck, renderViews, exportStl, readPngBase64,
  openscadVersion, DEFAULT_VIEWS, CAMERA_PRESETS, DEFAULT_IMGSIZE, OPENSCAD_BIN,
} from './scad.mjs';
import { analyzeStl } from './mesh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_PASSES = Number(process.env.SCADFORGE_MAX_PASSES ?? 2);
const MODEL = process.env.SCADFORGE_MODEL || undefined;

const argv = process.argv.slice(2);
const PROBE = argv.includes('--probe');
const SEED_DEFECT = argv.includes('--seed-defect');
const SEED_FIXTURE = 'fixtures/mug-handle-underneath.scad';
const SEED_REQUEST = 'a coffee mug: a cylindrical cup with a loop handle on the side';
const USER_PROMPT = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

// ---------------------------------------------------------------- run state
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = path.join(HERE, 'out', runId);
const SCAD_PATH = path.join(RUN_DIR, 'model.scad');

const emptyUsage = () => ({
  input_tokens: 0, output_tokens: 0,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
});

const state = {
  pass: 0,                 // incremented by write_scad; 0 = planning, before any write
  passes: [],              // per-pass record
  // Tokens burned before the first write_scad (system prompt + tool schemas + planning).
  plan: { pass: 0, started: Date.now(), ended: null, usage: emptyUsage(), tools: [], images: 0 },
  toolCalls: [],
  assistantTexts: [],   // what the agent said, per pass — the self-correction evidence
  transcript: [],
  imagesDelivered: 0,
};

/** The pass currently being billed. Before the first write_scad that is the plan bucket. */
function currentPass() {
  return state.passes.length ? state.passes[state.passes.length - 1] : state.plan;
}
function newPass() {
  state.pass += 1;
  const p = { pass: state.pass, started: Date.now(), ended: null, usage: emptyUsage(), tools: [], images: 0 };
  state.passes.push(p);
  return p;
}
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

/**
 * Bill one API response to the pass that is open when its `message_delta` arrives.
 * The delta lands AFTER the response's tool calls have run, so a response that emitted
 * write_scad is billed to the pass that write opened — which is what we want.
 */
function addUsage(u) {
  const bucket = currentPass();
  for (const k of USAGE_KEYS) bucket.usage[k] += u?.[k] ?? 0;
}
function note(name, detail) {
  currentPass().tools.push(name);
  state.toolCalls.push({ pass: state.pass, name, at: Date.now(), ...detail });
}

const jsonBlock = (o) => ({ type: 'text', text: JSON.stringify(o) });

// ---------------------------------------------------------------- tools
const writeScad = tool(
  'write_scad',
  'Write the complete contents of model.scad and run an OpenSCAD syntax/evaluation check. ' +
  'Whole-file writes only. Each call starts a new build pass; the pass budget is limited.',
  {
    code: z.string().describe('The complete .scad file contents.'),
    rationale: z.string().max(400).describe('One or two sentences: what changed and why.'),
  },
  async ({ code, rationale }) => {
    if (state.pass >= MAX_PASSES) {
      note('write_scad', { refused: true });
      return {
        content: [jsonBlock({
          ok: false,
          error_code: 'PASS_BUDGET_EXHAUSTED',
          message: `Pass budget of ${MAX_PASSES} exhausted (SCADFORGE_MAX_PASSES). ` +
                   'Do not write again. Stop and hand back a short summary of the current state, ' +
                   'including any defect you could not fix.',
          passes_used: state.pass,
          max_passes: MAX_PASSES,
        })],
        isError: true,
      };
    }
    currentPass().ended = Date.now();
    newPass();

    await mkdir(RUN_DIR, { recursive: true });
    await writeFile(SCAD_PATH, code, 'utf8');
    await writeFile(path.join(RUN_DIR, `pass-${state.pass}.scad`), code, 'utf8');
    const check = await syntaxCheck(SCAD_PATH, RUN_DIR);
    note('write_scad', { pass: state.pass, ok: check.ok, rationale });

    return {
      content: [jsonBlock({
        ok: check.ok,
        pass: state.pass,
        max_passes: MAX_PASSES,
        passes_remaining: MAX_PASSES - state.pass,
        bytes: Buffer.byteLength(code, 'utf8'),
        syntax_check: { ok: check.ok, errors: check.errors, warnings: check.warnings, ms: check.ms },
      })],
      isError: !check.ok,
    };
  },
);

const renderViewsTool = tool(
  'render_views',
  'Render model.scad to PNG images and return them to you as images. ' +
  'You MUST look at these images before declaring the model done.',
  {
    views: z.array(z.enum(['iso', 'front', 'top', 'right', 'section'])).optional()
      .describe('Views to render. Default: iso, front, right, section.'),
    imgsize: z.array(z.number().int().min(128).max(1024)).length(2).optional()
      .describe('[width, height] in px. Default 512x512.'),
  },
  async ({ views, imgsize }) => {
    const chosen = views?.length ? views : DEFAULT_VIEWS;
    const size = imgsize ?? DEFAULT_IMGSIZE;
    const renders = await renderViews(SCAD_PATH, RUN_DIR, chosen, size);

    const content = [jsonBlock({
      ok: renders.every((r) => r.ok),
      pass: state.pass,
      views: renders.map((r) => ({
        view: r.view,
        ok: r.ok,
        camera: CAMERA_PRESETS[r.view === 'section' ? 'iso' : r.view],
        projection: 'ortho',
        imgsize: size,
        bytes: r.bytes,
        render_ms: r.ms,
        stderr: r.stderr || null,
      })),
      note: 'The images below follow in the same order. "section" is the model cut by a ' +
            'half-space on Y so you can see internal walls and holes.',
    })];

    let delivered = 0;
    for (const r of renders) {
      if (!r.ok) continue;
      content.push({ type: 'text', text: `view: ${r.view}` });
      content.push({ type: 'image', data: await readPngBase64(r.path), mimeType: 'image/png' });
      delivered++;
    }
    state.imagesDelivered += delivered;
    currentPass().images += delivered;
    note('render_views', { pass: state.pass, views: chosen, images: delivered });

    return { content, isError: !renders.every((r) => r.ok) };
  },
);

const validateMesh = tool(
  'validate_mesh',
  'Export model.scad to a mesh and return geometry statistics: manifoldness, volume, bbox, ' +
  'triangle count, disconnected component count, and warnings. Treat warnings as blocking.',
  {},
  async () => {
    const exported = await exportStl(SCAD_PATH, RUN_DIR);
    if (!exported.ok) {
      note('validate_mesh', { pass: state.pass, ok: false });
      return {
        content: [jsonBlock({
          ok: false, error_code: 'EXPORT_FAILED',
          message: 'OpenSCAD could not export a mesh.', stderr: exported.stderr,
        })],
        isError: true,
      };
    }
    let stats;
    try {
      stats = await analyzeStl(exported.path);
    } catch (err) {
      note('validate_mesh', { pass: state.pass, ok: false });
      return {
        content: [jsonBlock({ ok: false, error_code: 'MESH_PARSE_FAILED', message: String(err) })],
        isError: true,
      };
    }
    const ok = stats.manifold && stats.warnings.length === 0;
    note('validate_mesh', { pass: state.pass, ok, components: stats.components });
    return {
      content: [jsonBlock({ ok, pass: state.pass, export_ms: exported.ms, stl_bytes: exported.bytes, ...stats })],
      isError: false,
    };
  },
);

const scadforge = createSdkMcpServer({
  name: 'scadforge',
  version: '0.0.0',
  tools: [writeScad, renderViewsTool, validateMesh],
});

const TOOL_NAMES = ['mcp__scadforge__write_scad', 'mcp__scadforge__render_views', 'mcp__scadforge__validate_mesh'];

// ---------------------------------------------------------------- prompts
const SYSTEM_PROMPT = `You are ScadForge, an agent that authors parametric OpenSCAD models.

TOOLS — these are the ONLY way you can act. You have no filesystem or shell access.
  write_scad     write the complete model.scad (whole-file writes) + syntax check
  render_views   render PNGs; the images come back to you as images — LOOK AT THEM
  validate_mesh  mesh statistics; treat every warning as blocking

REQUIRED LOOP, in this order:
  1. write_scad
  2. render_views
  3. validate_mesh
  4. Inspect the rendered images and the validation JSON. If the geometry does not match
     the request, or validation reports any warning, fix it with ONE more write_scad and
     repeat 2-3. Otherwise stop.

PASS BUDGET: you get at most ${MAX_PASSES} write_scad calls per turn (SCADFORGE_MAX_PASSES).
Spend the second one only on a real defect. Stop early when the render looks right and
validation is clean.

OPENSCAD STYLE:
  - All units mm. Parameters first, helper modules second, geometry last.
  - Every user-tunable value is a top-level parameter with Customizer syntax, e.g.
      /* [Main] */
      cube_size = 20;   // [5:100]
  - $fn discipline: coarse for preview (e.g. $fn = 48), do not go above 128.
  - Prefer a single fused solid via union()/hull(); disconnected components are a defect
    unless the user explicitly asked for separate pieces.
  - Target OpenSCAD 2021.01: no manifold backend, no BOSL2 available. Plain primitives only.

INSPECTION RULES — this is the part that matters:
  - Never declare done without having looked at a render of the CURRENT code.
  - Things to look for: parts floating or not touching, features in the wrong place,
    holes that do not go through, wall thickness of zero, the model being empty.
  - validate_mesh reporting components > 1 means the model is in pieces. That is a defect.

OUTPUT CONTRACT: your final message is a SHORT natural-language summary (a few sentences)
plus the list of parameters you exposed. NEVER paste the .scad source into your reply —
the user sees the file in a Code tab.`;

const PROBE_SYSTEM_PROMPT = `You are a vision probe. Call render_views exactly once, read the
characters that are physically modelled in the returned image, and reply with ONLY those
characters and nothing else. If you cannot see any image at all, reply exactly: NO_IMAGE_RECEIVED`;

function probeScad(code) {
  return `// vision probe
$fn = 24;
linear_extrude(height = 4)
  text("${code}", size = 20, spacing = 1.3, halign = "center", valign = "center", font = "Helvetica:style=Bold");
translate([0, 0, -2]) cube([120, 40, 2], center = true);
`;
}

// ---------------------------------------------------------------- driver
function fmt(n) { return n.toLocaleString('en-US'); }

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const version = await openscadVersion();
  console.log('─'.repeat(72));
  console.log('ScadForge Spike 3 — Agent SDK write→render→validate→fix loop');
  console.log(`  openscad     : ${OPENSCAD_BIN} — ${version.split('\n')[0]}`);
  console.log(`  max passes   : ${MAX_PASSES} (SCADFORGE_MAX_PASSES)`);
  console.log(`  run dir      : ${RUN_DIR}`);
  console.log(`  mode         : ${PROBE ? 'image-tool-result probe' : SEED_DEFECT ? 'seeded render-only defect' : 'build loop'}`);
  console.log('─'.repeat(72));

  let prompt;
  let systemPrompt;
  let expectedProbe = null;

  if (PROBE) {
    // Physically model a random code so the ONLY way to report it is to see the image.
    // Alphabet excludes glyph pairs that are ambiguous in a low-res extruded render
    // (C/6/G, O/0/D, I/1/L, S/5, Z/2, B/8, U/V).
    expectedProbe = Array.from({ length: 4 }, () =>
      'AEFHJKMNPRTWXY347'[Math.floor(Math.random() * 17)]).join('');
    await writeFile(SCAD_PATH, probeScad(expectedProbe), 'utf8');
    console.log(`  probe code   : (hidden from the model, revealed after the run)`);
    systemPrompt = PROBE_SYSTEM_PROMPT;
    prompt = 'Call render_views with views=["iso"] and imgsize=[1024,512], then reply with only the characters you see.';
  } else if (SEED_DEFECT) {
    // A mug whose handle lies flat around the base like a skirt. The mesh is a single
    // watertight manifold solid, so validate_mesh reports it 100% clean — the defect
    // exists ONLY in the rendered image.
    await writeFile(SCAD_PATH, await readFile(path.join(HERE, SEED_FIXTURE), 'utf8'), 'utf8');
    systemPrompt = SYSTEM_PROMPT;
    prompt =
      `A previous run left a model.scad in place for this request: "${SEED_REQUEST}".\n` +
      'Inspect the CURRENT file first with render_views and validate_mesh. ' +
      'Then fix anything that does not match the request. Do not rewrite it blind.';
    console.log(`  fixture      : ${SEED_FIXTURE}`);
    console.log(`  request      : ${SEED_REQUEST}`);
    console.log('─'.repeat(72));
  } else {
    if (!USER_PROMPT) {
      console.error('usage: node loop.mjs "<description of the part>"   |   node loop.mjs --probe   |   node loop.mjs --seed-defect');
      process.exit(2);
    }
    systemPrompt = SYSTEM_PROMPT;
    prompt = `Build this: ${USER_PROMPT}`;
    console.log(`  request      : ${USER_PROMPT}`);
    console.log('─'.repeat(72));
  }

  const wallStart = Date.now();
  state.plan.started = wallStart;
  let result = null;
  let finalText = '';

  const q = query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt,
      mcpServers: { scadforge },
      // `tools: []` disables every built-in tool, so the MCP server below is the agent's
      // entire action surface — no filesystem or shell escape hatch. It also keeps the
      // three tool schemas resident instead of deferred behind ToolSearch.
      tools: [],
      allowedTools: TOOL_NAMES,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 40,
      // REQUIRED for honest per-pass accounting. `SDKAssistantMessage.message.usage` is a
      // message_start snapshot (output_tokens is a placeholder, and the same object is
      // repeated for every block of one API response). Only the `message_delta` stream
      // event carries the real per-response usage. See README §"Token accounting".
      includePartialMessages: true,
      // MUST be an explicit []. In 0.3.246 *omitting* settingSources does NOT isolate:
      // the host's ~/.claude settings, CLAUDE.md, skills and plugin catalogs get loaded
      // (measured: ~50,500 extra input tokens, ~$0.50/cold run). See README §"Isolation".
      settingSources: [],
      stderr: (d) => { if (process.env.SCADFORGE_DEBUG) process.stderr.write(`[cli] ${d}`); },
    },
  });

  for await (const msg of q) {
    if (msg.type !== 'stream_event') {
      state.transcript.push({ t: Date.now() - wallStart, type: msg.type, subtype: msg.subtype ?? null });
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log(`  session      : ${msg.session_id}`);
      console.log(`  model        : ${msg.model ?? '(default)'}`);
      console.log(`  apiKeySource : ${msg.apiKeySource}`);
      console.log(`  tools        : ${(msg.tools ?? []).filter((t) => t.startsWith('mcp__scadforge')).join(', ')}`);
      console.log('─'.repeat(72));
      state.session = { id: msg.session_id, model: msg.model, apiKeySource: msg.apiKeySource, tools: msg.tools };
      continue;
    }

    if (msg.type === 'stream_event') {
      if (msg.event?.type === 'message_delta' && msg.event.usage) {
        if (process.env.SCADFORGE_DEBUG) {
          const u = msg.event.usage;
          console.log(`[usage] pass=${state.pass} out=${u.output_tokens} cr=${u.cache_read_input_tokens} cw=${u.cache_creation_input_tokens}`);
        }
        addUsage(msg.event.usage);
      }
      continue;
    }

    if (msg.type === 'assistant') {
      for (const block of msg.message.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          finalText = block.text;
          state.assistantTexts.push({ pass: state.pass, text: block.text.trim() });
          console.log(`\n[${state.pass ? `pass ${state.pass}` : 'plan'}] assistant: ${block.text.trim()}`);
        } else if (block.type === 'tool_use') {
          const short = block.name.replace('mcp__scadforge__', '');
          const arg = short === 'write_scad'
            ? ` — ${block.input?.rationale ?? ''}`
            : short === 'render_views'
              ? ` — ${(block.input?.views ?? DEFAULT_VIEWS).join(',')}`
              : '';
          console.log(`[${state.pass ? `pass ${state.pass}` : 'plan'}] → ${short}${arg}`);
        }
      }
      if (msg.error) console.error(`[error] assistant message error: ${msg.error}`);
      continue;
    }

    if (msg.type === 'user' && !msg.isReplay) {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_result') {
          // On isError results the CLI collapses `content` to a plain string, so handle both.
          const blocks = Array.isArray(block.content) ? block.content : [];
          const imgs = blocks.filter((b) => b.type === 'image').length;
          let summary = typeof block.content === 'string'
            ? block.content
            : (blocks.find((b) => b.type === 'text')?.text ?? '');
          try {
            const parsed = JSON.parse(summary);
            summary = Object.entries(parsed)
              .filter(([k]) => ['ok', 'pass', 'manifold', 'components', 'volume_mm3', 'triangle_count', 'error_code'].includes(k))
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
            if (parsed.warnings?.length) summary += ` warnings=${JSON.stringify(parsed.warnings)}`;
            if (parsed.syntax_check?.errors?.length) summary += ` errors=${JSON.stringify(parsed.syntax_check.errors)}`;
          } catch { summary = summary.slice(0, 200); }
          console.log(`[${state.pass ? `pass ${state.pass}` : 'plan'}] ← ${summary}${imgs ? `  [+${imgs} image blocks]` : ''}`);
        }
      }
      continue;
    }

    if (msg.type === 'result') {
      result = msg;
      const p = currentPass();
      if (!p.ended) p.ended = Date.now();
    }
  }

  const wallMs = Date.now() - wallStart;

  // ------------------------------------------------------------ report
  console.log('\n' + '═'.repeat(72));
  if (PROBE) {
    const seen = (finalText || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const exact = seen.includes(expectedProbe);
    const hits = expectedProbe.split('').filter((c, i) => seen[i] === c).length;
    const pass = exact || hits >= 2; // >=2/4 positional hits is impossible without seeing the image
    console.log('IMAGE TOOL-RESULT PROBE');
    console.log(`  modelled in the PNG : ${expectedProbe}`);
    console.log(`  model reported      : ${seen || '(nothing)'}`);
    console.log(`  image blocks sent   : ${state.imagesDelivered}`);
    console.log(`  positional matches  : ${hits}/4 (exact=${exact})`);
    console.log(`  VERDICT             : ${pass ? 'PASS — the model can see MCP image tool-results' : 'FAIL — no image reached the model'}`);
    console.log('═'.repeat(72));
  }

  console.log('PER-PASS COST');
  console.log('  pass  wall_s   in_tok  out_tok  cache_r  cache_w  imgs  tools');
  for (const p of [state.plan, ...state.passes]) {
    if (p === state.plan && p.usage.input_tokens + p.usage.output_tokens === 0) continue;
    const s = (((p.ended ?? Date.now()) - p.started) / 1000).toFixed(1);
    console.log(
      `  ${(p.pass === 0 ? 'plan' : String(p.pass)).padEnd(4)}  ${s.padStart(6)}  ` +
      `${fmt(p.usage.input_tokens).padStart(7)}  ${fmt(p.usage.output_tokens).padStart(7)}  ` +
      `${fmt(p.usage.cache_read_input_tokens).padStart(7)}  ${fmt(p.usage.cache_creation_input_tokens).padStart(7)}  ` +
      `${String(p.images).padStart(4)}  ${p.tools.join(',')}`,
    );
  }
  console.log(`  ── total wall: ${(wallMs / 1000).toFixed(1)}s   passes used: ${state.pass}/${MAX_PASSES}` +
              `   image blocks delivered: ${state.imagesDelivered}`);
  if (result) {
    console.log(`  ── SDK result: subtype=${result.subtype} turns=${result.num_turns} ` +
                `cost_usd=${result.total_cost_usd?.toFixed(4)} api_ms=${result.duration_api_ms}`);
    console.log(`  ── SDK usage : in=${fmt(result.usage?.input_tokens ?? 0)} out=${fmt(result.usage?.output_tokens ?? 0)} ` +
                `cache_read=${fmt(result.usage?.cache_read_input_tokens ?? 0)} ` +
                `cache_write=${fmt(result.usage?.cache_creation_input_tokens ?? 0)}`);
    if (result.subtype !== 'success') console.log(`  ── errors: ${JSON.stringify(result.errors ?? [])}`);
  }
  console.log('═'.repeat(72));
  console.log(`artifacts: ${RUN_DIR}`);

  await writeFile(
    path.join(RUN_DIR, 'run.json'),
    JSON.stringify({
      runId, mode: PROBE ? 'probe' : SEED_DEFECT ? 'seed-defect' : 'build',
      prompt: USER_PROMPT || prompt, seedFixture: SEED_DEFECT ? SEED_FIXTURE : null,
      openscad: version, maxPasses: MAX_PASSES, wallMs,
      probeExpected: expectedProbe, finalText,
      session: state.session, plan: state.plan, passes: state.passes,
      toolCalls: state.toolCalls, assistantTexts: state.assistantTexts,
      imagesDelivered: state.imagesDelivered,
      result: result && {
        subtype: result.subtype, num_turns: result.num_turns,
        total_cost_usd: result.total_cost_usd, usage: result.usage,
        modelUsage: result.modelUsage, duration_ms: result.duration_ms,
        duration_api_ms: result.duration_api_ms,
      },
    }, null, 2),
    'utf8',
  );

  process.exit(result && result.subtype !== 'success' ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err?.stack ?? err);
  process.exit(1);
});
