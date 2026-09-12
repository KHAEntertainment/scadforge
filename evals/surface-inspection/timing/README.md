# S2-6 timing fixtures and harness

The timing-measurement half of [S2-6](../../../../.traycer/epics/ca1c7904-3e6c-4a5e-a4fd-09d50c993053/artifacts/combined-measurement-editor-plan/s2-surface-inspection-scope/tickets/s2-6-qualification-walk/index.md)
(the human-walk half needs S2-4/S2-5's UI and is not here). Measures
`inspectSurface` timing in Node against the proposed budget — not a vitest
gate, not tuned against.

## Files

| File | What it is |
| --- | --- |
| `F5-detail.scad` | The S0 "F5" fixture, copied byte-for-byte from the spike worktree (see verification below) |
| `stress-plate.scad` | Hand-authored large mesh (~105k triangles) — the fixture-derived meshes only cover 1,000–2,400 triangles |
| `measure-inspect.mjs` | Renders every timing sample with the pinned OpenSCAD image and times `inspectSurface` |
| `ts-loader.mjs` | Tiny Node ESM resolution hook the harness needs to import `apps/web`'s TS sources directly (see "Why `--experimental-strip-types`..." below) |

## `F5-detail.scad` provenance and hash verification

Source: `/Users/bbrenner/.traycer/worktrees/khaentertainment__scadforge/live-solid-editor-spike/evals/live-solid/F5-detail.scad`
(an uncommitted spike file — never imported from or modified; copied bytes
only, then verified independently in this repo).

`F5-detail.scad` has no direct entry in that worktree's
`evals/live-solid/evidence/v3-source-manifest.json` (that manifest hashes a
different file set — `fixtures.json`, the spike server/worker sources,
etc.). Its source text is, however, embedded verbatim as the `"source"`
field of the `"id": "F5-detail"` entry in `evals/live-solid/fixtures.json`,
and *that* file **is** in the manifest. So the file is verified via that
chain, computed independently in this repo rather than trusted from the
spike:

1. `evals/live-solid/fixtures.json` (spike worktree) hashes to
   `92950755311ecf39ed319f9c744f087c3986a4366dc9c29b5c773fe864bd4d2a`,
   matching the manifest's recorded hash for that path exactly.
2. The `source` field of its `"F5-detail"` entry, hashed as UTF-8 bytes, is
   `02d82bea0152f321d02050c57de5f697303fd8494705fcf88b4484797f9611fe`.
3. `evals/surface-inspection/timing/F5-detail.scad` (this file, copied
   byte-for-byte) hashes to the same value:
   `02d82bea0152f321d02050c57de5f697303fd8494705fcf88b4484797f9611fe`.

All three agree. `F5-detail.scad` carries no license header at all (a
215-byte one-line spike snippet) — nothing to conflict with the `evals/`
convention, so nothing was added to the copy (that would have changed its
hash); this README carries the provenance instead.

## Which F5 variant is "F5-scale"

`F5-detail.scad`'s own literals are `w=80; quality=96;`. The S0 evidence
(`evals/live-solid/evidence/mesh-F5-detail-{low,mid,high,draft-high}.json`,
spike worktree) recorded four rendered variants:

| Evidence variant | `w` | `quality` (`$fn`) |
| --- | --- | --- |
| `low` | 60 | 96 |
| `mid` | 90 | 96 |
| `high` | 120 | 96 |
| `draft-high` | 120 | 24 |

`low`/`mid`/`high` there name *width* settings (`fixtures.json`'s swept
param for this fixture is `w`, range `[60, 120]`) — all three render to the
**identical** triangle count (confirmed: identical STL byte length in the
evidence files), since `w` only stretches the footprint, not the feature
count. `quality` (OpenSCAD's `$fn`) is the one dimension that changes
triangle count, and it is a plain hardcoded literal in the source, not a
Customizer-range parameter — so there is no separate "default vs.
high-detail" pair *within the file itself* the way there is for
`quality=96` (every named width variant) vs. `draft-high`'s `quality=24`
(a lower-fidelity override S0 tested separately, for a different, draft-
preview scenario).

Reading "F5-scale" as "the mesh S0 used as its complexity reference for
this fixture": `quality=96` is the highest value across every S0 evidence
variant for F5, and the file's own default **is** `quality=96`. So this
harness renders `F5-detail.scad` exactly as authored (`w=80, quality=96`,
no overrides) as the single F5 timing sample — it already is both "F5 at
its default" and the highest-triangle-count variant S0 recorded for it.
`w` does not affect triangle count, so a second width-only render would add
no new timing information.

## `stress-plate.scad`

Every fixture-derived mesh (clamp, hinge, F5) renders to 1,000–2,400
triangles, so on its own the timing table only covers small meshes. This is
a hand-authored plate with a `hole_cols × hole_rows` grid of `$fn = 48`
through-holes plus a `boss_cols × boss_rows` grid of cylindrical bosses
(offset by half a hole pitch so no boss centers on a hole), sized (by
rendering and checking, not by a formula — CSG boolean seams add real
facets beyond a naive `features × $fn` estimate) to land at **104,972
triangles**, one solid, comfortably inside the requested 80k–120k band.

## Results (this machine: darwin arm64, Apple M1 Pro ×10, Node v26.7.0, three 0.169.0)

| mesh | triangles | 1st-click median | 1st-click max | budget (≤100ms) | later median | later p95 | budget (≤16ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| clamp/wall2 | 1,198 | ~4–13ms | ~13ms | PASS | <1ms | ~1–1.3ms | PASS |
| clamp/wall4 | 1,118 | ~3ms | ~3.4ms | PASS | <1ms | <1ms | PASS |
| clamp/wall6 | 1,070 | ~2–4ms | ~2.6–6.3ms | PASS | <1ms | <1ms | PASS |
| hinge/low | 1,616 | ~3–8ms | ~4–10ms | PASS | <1ms | <1ms | PASS |
| hinge/mid | 1,632 | ~3–10ms | ~7–22ms | PASS | <1ms | ~1.5ms | PASS |
| hinge/high | 1,648 | ~2–12ms | ~3–25ms | PASS | <1ms | <1ms | PASS |
| F5-detail (default) | 2,352 | ~5–17ms | ~6–39ms | PASS | <1ms | ~1–2ms | PASS |
| **stress-plate** | **104,972** | **~350–460ms** | **~430–570ms** | **MISS (3.5–5.7×)** | <1ms | <1ms | PASS |

Ranges reflect real run-to-run variance on this laptop (see the note
below) across several independent process runs, not a single sample. Every
small mesh passes both budgets comfortably; `stress-plate` reliably misses
the first-click budget by 3.5–5.7×, reproducibly across 3 separate runs —
unlike the one F5 spike noted below, this is real, load-bearing data, not
noise.

Rough weld-vs-rest split on the stress-plate miss (weld measured
independently — see `timeWeldOnly` in `measure-inspect.mjs` — as a proxy
for `inspectSurface`'s own internal weld, not exported for this timing
script to call directly; "rest" is adjacency + region growth + circle fit,
inferred as the remainder): weld alone is already ~100–115ms — at or past
the *entire* 100ms budget by itself — with region growth/adjacency/fit
adding another ~150–345ms on top. No optimization was attempted (out of
scope for this ticket); this data point is what an optimization ticket
would need to start from.

## Running

```
node --experimental-strip-types evals/surface-inspection/timing/measure-inspect.mjs
```

Renders the clamp (`wall ∈ {2, 4, 6}`), the three hinge samples, and F5 with
the pinned image (`--backend=Manifold`), then times the REAL `inspectSurface`
(`apps/web/src/components/inspect/surfaceRegion.ts`) in Node against the
seed rays already verified in
`evals/surface-inspection/fixture/{clamp,hinge}.expected.json` (plus a
handful of curved-feature and random points on F5, which has no expected-
results file of its own). Prints a timing table and does not assert
anything — a miss against the proposed budget is data, not a gate. Not run
by `pnpm -r test` (no `.test.` in its name; vitest's default include glob
never matches it).

### Why `--experimental-strip-types` and `ts-loader.mjs`

`apps/web` has no plain-JS build output for its `inspect/` modules (only a
Vite browser bundle, not reusable from a Node script) — so this harness
imports the TypeScript sources directly rather than duplicating their logic
(which would time a reimplementation, not the real thing).

- `--experimental-strip-types` (a real Node CLI flag, `node --help`) strips
  TS syntax without needing `tsx`/`ts-node` as a project dependency — plain
  interfaces/types only, nothing this codebase's `inspect/` modules don't
  already use.
- Node's stripping does not also rewrite module resolution:
  `apps/web`'s TS sources import siblings by their emitted-JS name (e.g.
  `./thresholds.js`, the standard `nodenext` convention `tsc`/Vite resolve
  for you) — plain Node looks for a literal `.js` file and fails.
  `ts-loader.mjs`, registered once via `module.register()` at the top of
  `measure-inspect.mjs`, retries a failed `.js` specifier as `.ts` before
  giving up. Together the two need nothing beyond what's already in this
  repo — no tsx, no new dependency.
- `module.register()` itself prints a harmless `[DEP0205]` deprecation
  warning on newer Node (it's been superseded by `registerHooks()`) — kept
  anyway since it's the API that actually works unmodified across the whole
  Node 22–26 range this could run under; `registerHooks()` is too new to
  assume for a pinned-at-22 repo.

### A note on run-to-run noise

This is a laptop dev machine, not a controlled benchmark host — timings
here have shown real run-to-run variance (see the reported results: one
early run showed F5's first-call time spiking into the hundreds of ms,
un-reproduced across five further independent process runs that all landed
in single digits, in line with F5's triangle count sitting between the
clamp's and the hinge's). Report several runs, not one, if a number looks
like it might matter.
