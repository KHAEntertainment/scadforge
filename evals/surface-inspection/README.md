# Surface-inspection fixtures (S2-3)

Fixtures and hand-derived expected results for cylindrical surface
inspection (`inspectSurface`, S2). This directory holds fixture DATA only —
no `inspectSurface` implementation exists here, and no vitest specs. The
`@docker` fixture tests that load these files and assert against a rendered
mesh belong to a later phase.

## Files

| File | What it is |
| --- | --- |
| `fixture/hinge.scad` | Hand-authored three-knuckle hinge leaf, new for S2 (topologically distinct from the clamp) |
| `fixture/hinge.expected.json` | Per-sample, per-feature rays + expected `inspectSurface` outcomes for the hinge |
| `fixture/clamp.expected.json` | Same, for the existing `evals/scenario-a2/fixture/clamp.scad`, at `wall ∈ {2, 4, 6}` |

Both `.expected.json` files share one shape:

```jsonc
{
  "fixture": "path/to/the.scad",
  "renderedWith": { "image": "...@sha256:...", "backend": "Manifold", "version": "..." },
  "toleranceMm": 0.01,
  "samples": {
    "<sampleName>": {
      "params": { /* Customizer overrides for this sample */ },
      "meshValidation": { "components": 1, "volume_mm3": ..., "bbox": {...}, "genus": ... },
      "rays": [
        {
          "feature": "...",
          "ray": { "origin": [x, y, z], "direction": [x, y, z] },
          "expected": { "status": "recognized", "surface": "hole" | "outside", "axis": "X" | "Y" | "Z", "diameterMm": ..., "center": [x, y, z] }
          // or: "expected": { "status": "refused", "code": "planar" | "not-axis-aligned" | "too-coarse" | "not-circular", "message": "..." }
        }
      ]
    }
  }
}
```

`diameterMm`/`center` are the exact closed-form modeled values (not a
raycast hit distance), because the recognizer's own circle fit runs over
polygon *vertices*, which OpenSCAD places exactly on the modeled circle —
see the scope doc's "Recognition method" §5. `direction` is always a unit
vector.

## Rendering a sample to STL (pinned engine)

Every sample in the JSON files was rendered with the pinned image
(CLAUDE.md "Pinned toolchain" / `packages/scad-core/src/types.ts`
`OPENSCAD_IMAGE`):

```
docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7
```

The exact flags mirror `packages/scad-core/src/runner/mesh-export.ts`
(`--backend=Manifold --render=true --colorscheme=Cornfield`, one `-D` per
overridden parameter, `--export-format=binstl`):

```bash
# Hinge, "mid" sample (pin_d=4.5, knuckle_wall=2 — the file's own defaults):
docker run --rm -v "$PWD/evals/surface-inspection/fixture:/work" -w /work \
  docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7 \
  openscad -o /work/hinge-mid.stl --export-format=binstl \
  --backend=Manifold --render=true --colorscheme=Cornfield \
  -D pin_d=4.5 -D knuckle_wall=2 \
  /work/hinge.scad

# Hinge, "low" / "high" samples: swap in -D pin_d=3 -D knuckle_wall=1.5, and
# -D pin_d=6 -D knuckle_wall=3.5.

# Clamp, wall=2 / 4 / 6 (same flags, against the existing fixture):
docker run --rm -v "$PWD/evals/scenario-a2/fixture:/work" -w /work \
  docker.io/openscad/openscad@sha256:0af06bc2aa7a45d18b01a23cfb9dae6dddcd9542611e7be50edea6beb3b52fa7 \
  openscad -o /work/clamp-wall2.stl --export-format=binstl \
  --backend=Manifold --render=true --colorscheme=Cornfield \
  -D wall=2 \
  /work/clamp.scad
```

In practice these renders were driven through
`@scadforge/scad-core`'s own `validateModel()` (same flags, same runner,
`persistMeshTo` to keep the STL) rather than raw `docker run`, so the
component/volume/bbox numbers in the `.expected.json` files came from the
same manifold-3d validation path the product uses, not a hand-rolled
parallel implementation.

## How the rays were verified

Per the ticket's specified method: each `.expected.json` ray was cast
against the real rendered STL with three's `STLLoader` (`loader.parse()`
straight from the binary STL bytes) and `Raycaster` — no WebGL involved, no
browser. The nearest hit's point, distance, and true flat FACE normal
(recomputed from the hit triangle's own vertices, not a smoothed/interpolated
vertex normal) were checked against each row's expected surface
(hole vs. outside, from which way the normal points relative to the ray)
and axis (from which single principal axis the normal is perpendicular to).

Two things worth recording for whoever writes the `@docker` fixture tests
next:

- **Ray angle.** Every "radial" ray uses a fixed, deliberately *unaligned*
  angle (37° off the relevant axis, or 217°/30° for the slot/hex cap
  picks) rather than an exact 45°. An exact 45° ray from an on-axis origin
  landed exactly on a `$fn = 48` vertex seam for one knuckle at one sample
  (48 segments → 7.5° steps; 45° is 6 steps exactly) — `Math.SQRT1_2` and
  `Math.cos(Math.PI / 4)` differ in their last bit, and that was enough to
  flip a real hit into a miss on that one STL. None of the chosen angles are
  multiples of 7.5° (the body's `$fn = 48`) or 60° (the hex boss's `$fn = 6`).
- **Don't call `computeVertexNormals()` on the loaded geometry.** On this
  repo's pinned `three@0.169.0`, calling it on the non-indexed STL geometry
  before raycasting corrupted the raycast result on at least one region
  (reproduced: a genuine near hit silently became a miss). The rays here
  were verified — and any test built on them should raycast — against the
  geometry exactly as `STLLoader.parse()` returns it; recompute a flat face
  normal from the hit triangle's own vertices instead (three's own vertex
  normals aren't needed for this — the recognizer reads facet-flat normals
  anyway).

## Regenerating

Nothing here is generated by a checked-in script (scratch tooling only, not
committed) — the `.expected.json` files are the deliverable. If the hinge
geometry ever changes, re-derive by: render each sample with
`validateModel()` (or the docker commands above) for the mesh-validation
block, then re-cast the rays above against the fresh STL and update the
`diameterMm`/`center`/`ray` values that changed.
