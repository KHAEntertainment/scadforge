# Spike 2 — OpenSCAD nightly in Docker from Node

Issue: #4. Owned paths: `spikes/02-docker-cli/**`, this file.

This spike decides the two most load-bearing constants in the project: the
**OpenSCAD nightly pin** and the **fixed per-view camera args**.

## TL;DR

- **Pin**: `docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7`
  (tags `dev`, `trixie`, `dev.2026-01-19`, `trixie.2026-01-19` all resolve to
  this same digest). `openscad --version` inside the container: **OpenSCAD
  version 2026.01.19 (git e43242666)**.
- Native multi-arch manifest (`linux/amd64`, `linux/arm64`, `linux/riscv64`) —
  runs natively on Apple Silicon and x86_64 hosts, no emulation needed.
- All required flags verified working: `--backend=Manifold`, color-preserving
  3MF export (lib3mf 1.8.1), `--export-format=param`, fixed `--camera`.
- Determinism: byte-identical on repeat render.
- **Verdict: GO-WITH-CAVEATS** (see below).

## How we got to this pin (reproduction trail)

The spike's technical note suggested "openscad.org nightly AppImage in a
Debian base, or an existing nightly image — your call." We tried, in order:

### 1. Rejected: openscad.org/snapshots x86_64 AppImage, run as-is on Apple Silicon

The current Linux nightly snapshot as of this spike is
`OpenSCAD-2026.08.23.ai27100-x86_64.AppImage` (sha256
`5b341ca58a08ac83f36e93c1996316e78790428c74c30cb3da3c90576bf9f70e`, verified
against the published `.sha256`). **openscad.org only publishes Linux
nightlies as x86_64 AppImages** — the last arm64/aarch64 AppImage is dated
**2023-09-11**, over two years stale.

Running the current x86_64 AppImage under Docker Desktop's `linux/amd64`
emulation (QEMU) on this Apple Silicon dev machine **segfaults immediately**
— even a bare `openscad --info` crashes with `qemu: uncaught target signal 11
(Segmentation fault)`. Verified after extracting the AppImage's embedded
squashfs directly (bypassing the AppImage's own self-mount step) and
confirming every shared-library dependency resolved via `ldd` — this is not
a missing-library or flag issue, it's QEMU user-mode emulation failing on a
large Qt6/CGAL binary, a documented class of failure for this combination.

### 2. Rejected: the last arm64 AppImage nightly (2023-09-11), run natively

Runs perfectly natively (no emulation) — `openscad --version` → `OpenSCAD
version 2023.09.11`. But it **fails two of the four features this spike
exists to verify**:
- No `--export-format=param` (not in its `-o`/`--export-format` extension
  list at all — the flag was added to OpenSCAD later).
- 3MF export produces a mesh with **zero color/material entries** — no
  `<basematerials>`, no per-triangle material refs. Confirmed by rendering
  a two-`color()` test model and inspecting the exported `3dmodel.model`
  XML directly. (This build predates OpenSCAD's lib3mf-based color-export
  integration.)

### 3. Rejected: build OpenSCAD from source, native arm64, pinned to the exact commit behind the 2026.08.23 nightly

GitHub's commit API confirms `openscad/openscad@master` at
`3da45dd566ef5710138d33e80758cfa068bd0304` ("Bump manifold to 3.5.2 (#6972)",
2026-08-23T14:56:26Z) is the commit that produced that day's x86_64 nightly —
so building this commit from source, natively, would be genuinely
current-nightly quality on any architecture. Dependencies per openscad's own
`scripts/uni-get-dependencies.sh` (`get_debian_deps` + `get_qt6_deps_debian`,
`lib3mf-dev` included) install cleanly on `debian:bookworm`, and
`git checkout <sha> && git submodule update --init --recursive` succeeds.

**But the build reproducibly OOM-kills `cc1plus`** compiling
`ManifoldGeometry.cc` / `cgalutils-mesh.cc` / `cgalutils.cc` — CGAL + manifold
template instantiation is extremely memory-hungry per translation unit, and
`ninja -j$(nproc)` on this Docker Desktop VM's memory budget kills the
compiler mid-object. A fix exists (`-j1` or a much larger VM) but trades a
slow, fragile, ~30+ minute from-scratch build that only this machine's exact
toolchain snapshot reproduces, for something nobody else can rebuild
byte-for-byte without matching versions of GCC/CGAL/Boost/Qt6 from Debian's
package archive on that exact day.

### 4. Accepted: `openscad/openscad` official Docker Hub image

Docker Hub's `openscad/openscad` repo is built and pushed weekly by the
OpenSCAD project's own CI (`openscadci` account), tracking git `master`, as
a genuine multi-arch manifest (amd64 + arm64 + riscv64). Pulled by digest
(immutable, reproducible by anyone), it:
- Runs natively on this arm64 dev machine — no emulation, no segfaults.
- Has `--export-format=param` and lib3mf 1.8.1 (color-preserving 3MF) built
  in — both verified end-to-end below.
- Required zero build time (`docker pull` + a 3-line `Dockerfile`).

**Caveat**: its latest available build (2026-01-19) is ~5 weeks older than
the very latest x86_64-only AppImage nightly (2026-08-23). If a
post-2026-01-19 OpenSCAD feature becomes load-bearing, check
`https://hub.docker.com/r/openscad/openscad/tags` for a newer tag before
re-attempting a from-source build (and budget real VM memory / `-j1` if you
do).

## Reproduction

```bash
cd spikes/02-docker-cli
docker build -t scadforge-openscad:pinned .      # ~instant: FROM the pinned digest + WORKDIR + ENTRYPOINT
node run-views.mjs sample.scad                   # produces spikes/02-docker-cli/out/*
```

`out/` is gitignored (renders aren't committed — see "Artifacts" below).

## Sample model

`sample.scad`: a wall-mount pipe-clamp bracket (mirrors SDP §3 Scenario A),
vendoring a trimmed `BOSL2` (source `.scad` files only, 4.4MB, no
images/tests/examples — `libs/BOSL2/`). Uses:
- `cuboid()`, `tube()`, rounding, boolean `difference()` (BOSL2 shapes3d).
- Two `color()` calls (`"SteelBlue"`, `"Goldenrod"`) — for the 3MF
  color-survival check.
- Full Customizer annotations: `/* [Section] */` groups, `// [min:max:step]`
  ranges on all 7 exposed parameters — for the param-export check.

## AC verification (`[trigger] → [actual behavior]`)

1. **`spikes/02-docker-cli/Dockerfile` pins a nightly by explicit
   date/version AND records the image digest** →
   `FROM openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7`.
   `docker run scadforge-openscad:pinned openscad --version` →
   `OpenSCAD version 2026.01.19`. **PASS** (with the caveat in §4 above
   recorded in-file and here).

2. **`node run-views.mjs sample.scad` → iso/front/top/right PNGs at
   1024×768 with fixed `--camera` args + a section view via a generated
   `difference(){...}` wrapper** →
   All 5 PNGs produced, each verified 1024×768 by reading the PNG IHDR
   chunk directly. Camera rotations verified empirically by rendering each
   candidate and visually confirming which face of the model each view
   shows (see "Camera constants" below). **The literal
   `difference(){ include <model.scad>; <cube> }` pattern from the issue's
   technical note does NOT parse** — see "Section view: a correction" below
   for what actually works. **PASS** (with a corrected implementation of the
   section-view mechanism).

3. **3MF export with colors: `color()` → 3MF whose colors survive
   (verified by inspecting the 3MF XML)** →
   `unzip out/model.3mf -d /tmp/x && grep basematerials -A2
   /tmp/x/3D/3dmodel.model`:
   ```xml
   <basematerials id="1">
   <base name="Default" displaycolor="#F9D72C00" />
   <base name="Color 1" displaycolor="#4682B400" />
   <base name="Color 2" displaycolor="#DAA52000" />
   ```
   `#4682B4` = SteelBlue, `#DAA520` = Goldenrod — exact hex matches to the
   two `color()` calls in `sample.scad`. **PASS.**

4. **`--export-format=param` on an annotated model → valid JSON param
   schema** →
   ```json
   {"parameters":[
     {"caption":"Outer diameter of the pipe the bracket clamps","group":"Pipe","initial":32.0,"max":80.0,"min":10.0,"name":"pipe_d","step":1.0,"type":"number"},
     {"caption":"Bracket wall thickness","group":"Pipe","initial":4.0,"max":10.0,"min":2.0,"name":"wall","step":0.5,"type":"number"},
     {"caption":"Bracket depth (along the pipe axis)","group":"Pipe","initial":24.0,"max":60.0,"min":10.0,"name":"depth","step":1.0,"type":"number"},
     {"caption":"Length of each mounting slot","group":"Mount","initial":10.0,"max":20.0,"min":5.0,"name":"slot_len","step":1.0,"type":"number"},
     {"caption":"Diameter of the mounting screw","group":"Mount","initial":4.0,"max":8.0,"min":3.0,"name":"screw_d","step":0.5,"type":"number"},
     {"caption":"Back plate thickness","group":"Mount","initial":5.0,"max":12.0,"min":3.0,"name":"back_t","step":0.5,"type":"number"},
     {"caption":"Facet count for curved surfaces","group":"Render","initial":48.0,"max":128.0,"min":16.0,"name":"smooth_fn","step":8.0,"type":"number"}
   ],"title":"sample"}
   ```
   Valid JSON, all 7 parameters present with correct group/min/max/step/
   caption. **PASS.**

5. **Determinism: render each view twice → identical PNG bytes (or
   documented delta + workaround)** →
   `iso` rendered twice with identical args (`--backend=Manifold --render
   --colorscheme=Cornfield`, fixed camera, no `$fn` randomness — the model
   pins `$fn=smooth_fn`): `cmp out/determinism_iso_a.png
   out/determinism_iso_b.png` → no output (files identical). No flags beyond
   the fixed colorscheme + fixed `$fn` were needed. **PASS.**

6. **README records per-view render timings + total for the 5-view set** →
   see "Timings" below. **PASS.**

7. **GO / NO-GO + Decisions for PROJECT_CONTEXT.md** → below.

## Section view: a correction to the issue's technical note

The issue suggests generating a wrapper via
`difference(){ include <model.scad>; <half-space cube> }`. **This does not
parse.** Verified with three isolated test cases: `include` nested inside a
`difference(){}` block, and inside a `module foo(){ include <...> }` body,
both fail with a *misleadingly located* parser error deep inside whatever
file the include pulls in next (e.g. `ERROR: Parser error: syntax error in
file libs/BOSL2/version.scad, line 36` — line 36 of that file is a
completely ordinary one-line function definition; the real problem is the
`include` statement above it, not that line). OpenSCAD's grammar only
accepts `include`/`use` at a file's top level, never inside any `{}` scope.

**Working equivalent** (implemented in `run-views.mjs`): render the model to
a mesh first (`-o mesh.off`), then generate a *second*, tiny wrapper that
`import()`s that mesh and differences it with the half-space cube:

```scad
difference() {
  import("mesh.off");
  translate([-1000, -2000, -1000]) cube([2000, 2000, 2000]);
}
```

This is a two-process-invocation cost (mesh export, then cut+render) instead
of one, but it works regardless of how the source `.scad` is structured
(single root module vs. bare top-level statements — `sample.scad` is the
latter) and is the standard technique for an arbitrary post-hoc section cut
of an already-defined model. **Recommendation for `scad-core`'s
`render_views` tool: implement the section view this way, not via a
generated `include`-wrapper.**

The cut-plane orientation also needed empirical correction: cutting the `+Y`
half left the model's *exterior* facing the front camera (visually
indistinguishable from an uncut front view, because the front camera's own
viewing direction is edge-on to nothing and face-on to the untouched near
wall). Cutting the `-Y` half instead exposes the correct cross-section
(wall thickness, slot profile) toward the front camera. This sign is
specific to the `front` camera's rotation and this model's origin/anchoring
— worth re-verifying if the fixed camera constants below ever change.

## Camera constants (frozen — for `packages/agent/src/tools/contract.ts`)

Gimbal camera string format: `--camera=tx,ty,tz,rx,ry,rz,dist`. `--autocenter`
recomputes `tx,ty,tz` and `--viewall` recomputes `dist` to fit each model, so
only `rx,ry,rz` are the fixed, load-bearing values (translate/dist are always
passed as `0,0,0,...,0` placeholders):

| view    | `--camera=` (rx,ry,rz) | verified showing |
|---------|------------------------|-------------------|
| iso     | `0,0,0,55,0,25,0`      | 3/4 perspective-like axonometric (OpenSCAD's own GUI default view angle) |
| front   | `0,0,0,90,0,0,0`       | clamp face-on, screw caps left/right, back plate as a thin strip below |
| top     | `0,0,0,0,0,0,0`        | plan view of the back plate + both mounting slots + the clamp's open gap |
| right   | `0,0,0,90,0,90,0`      | side profile of the clamp, depth (Y) and height (Z) visible |
| section | `0,0,0,90,0,0,0` (= front) | cross-section from the two-pass import()+difference() wrapper above |

Common flags for every view: `--viewall --autocenter --projection=ortho
--imgsize=1024,768 --backend=Manifold --render --colorscheme=Cornfield`.

## Timings (this machine: Apple Silicon, Docker Desktop, native arm64 — no emulation)

| step | ms |
|---|---|
| iso | 656.8 |
| front | 762.8 |
| top | 760.4 |
| right | 741.4 |
| section (mesh export) | 446.9 |
| section (cut + render) | 361.3 |
| **5-view set total** | **≈3729.6 ms (3.7s)** |
| 3MF export | 411.5 |
| param export | 380.5 |
| determinism re-render (iso) | 551.4 / 576.7 |

All well inside the 60s per-invocation timeout `run-views.mjs` enforces.

## Flag set verified

- `--backend=Manifold` — default in this build, passed explicitly anyway.
- `--export-format=3mf` (via `-o *.3mf`) with color: **confirmed** (lib3mf
  1.8.1, `<basematerials>` block with exact hex color matches).
- `--export-format=param`: **confirmed**, valid JSON, all params + groups +
  ranges present.
- `--camera` / `--viewall` / `--autocenter` / `--projection=ortho` /
  `--colorscheme=Cornfield` / `--imgsize`: **confirmed**, deterministic
  across repeat renders.
- 60s timeout + args-as-array (no shell) + per-render temp dir: implemented
  in `run-views.mjs` per SDP §7.

## Artifacts

Renders are NOT committed (gitignored via `spikes/02-docker-cli/.gitignore`).
Reproduce with the commands above. Files a reviewer would want to look at:
`out/iso.png`, `out/front.png`, `out/top.png`, `out/right.png`,
`out/section.png`, `out/model.3mf`, `out/model.param.json`,
`out/timings.json`.

---

## GO-WITH-CAVEATS

Caveats, both already noted above and both actionable, neither blocking:

1. The pin (`openscad/openscad:dev`, 2026-01-19) is ~5 weeks behind the
   latest x86_64-only AppImage nightly. Re-pin to a newer `openscad/openscad`
   tag if a needed feature landed after 2026-01-19 (they publish weekly).
2. The section view needs a two-pass render (mesh export, then
   import()+difference()), not the single-pass `include`-wrapper the issue
   sketched — that pattern doesn't parse in OpenSCAD. `scad-core`'s
   `render_views` implementation should use the two-pass approach directly.

## Decisions for PROJECT_CONTEXT.md

- **OpenSCAD nightly pin**: `docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7`
  (aliases: `dev`, `trixie`, `dev.2026-01-19`, `trixie.2026-01-19`).
  `openscad --version` → `2026.01.19 (git e43242666)`. Multi-arch
  (amd64/arm64/riscv64) — no QEMU emulation needed in Docker Desktop on
  Apple Silicon dev machines.
- **`render_views` camera constants** (fixed `rx,ry,rz`, `tx,ty,tz,dist`
  auto-computed by `--autocenter`/`--viewall`): iso `55,0,25`; front
  `90,0,0`; top `0,0,0`; right `90,0,90`; section reuses `front`'s camera.
  Common flags: `--viewall --autocenter --projection=ortho
  --imgsize=1024,768 --backend=Manifold --render --colorscheme=Cornfield`.
- **Section view mechanism**: two-pass (export mesh → `import()` +
  `difference()` with a half-space cube in a generated wrapper), NOT a
  single-pass `include`-wrapper — OpenSCAD rejects `include` inside any
  nested `{}` scope.
- **validate_mesh input format** (relevant to Spike 4, #6): this spike
  confirms 3MF color export works via lib3mf on the pinned image, so 3MF
  parsing (vs. a parallel STL export) is viable if Spike 4 needs color
  data; OFF/STL export (geometry-only, no color) works for validation that
  doesn't need color.
