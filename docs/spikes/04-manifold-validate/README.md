# Spike 4: manifold-3d mesh validation

Issue: #6. Standalone package at `spikes/04-manifold-validate/` (not part of the
pnpm workspace, never imported by product code). Decides the `validate_mesh`
input path and the `ValidationReport` shape for the M1 contract freeze (#10).

## Reproduction

```bash
cd spikes/04-manifold-validate
npm install
node validate.mjs fixtures/good.3mf
node validate.mjs fixtures/good.stl
node validate.mjs fixtures/bad-mesh.stl
node validate.mjs fixtures/multi-island.stl
node validate.mjs fixtures/multi-island.3mf
```

Fixtures were generated with a local OpenSCAD 2021.01 stable install
(`which openscad` → `/opt/homebrew/bin/openscad`; no nightly/`--backend=manifold`
available locally, not required for this spike — plain CGAL export is enough
to produce valid/multi-island meshes). Regeneration commands:

```bash
cd fixtures
openscad -o good.3mf good.scad
openscad --export-format=binstl -o good.stl good.scad
openscad -o multi-island.3mf multi-island.scad
openscad --export-format=binstl -o multi-island.stl multi-island.scad
node make-bad-mesh.mjs   # hand-writes bad-mesh.stl (ASCII, human-auditable)
```

`good.scad` is a 20mm cube (expected volume 8000 mm³). `multi-island.scad` is
two disconnected 10mm cubes (expected 2 components, each volume 1000 mm³).
`bad-mesh.stl` is hand-constructed: a 20mm cube with the top face's two
triangles deliberately omitted (10 triangles instead of 12), leaving an open
4-edge boundary loop — not watertight, not manifold.

## Real outputs

```
$ node validate.mjs fixtures/good.3mf
{"manifold":true,"status":"NoError","volume_mm3":8000,"surface_area":2400,"bbox":{"min":[0,0,0],"max":[20,20,20]},"triangle_count":12,"components":1,"genus":0}

$ node validate.mjs fixtures/good.stl
{"manifold":true,"status":"NoError","volume_mm3":8000,"surface_area":2400,"bbox":{"min":[0,0,0],"max":[20,20,20]},"triangle_count":12,"components":1,"genus":0}

$ node validate.mjs fixtures/bad-mesh.stl
{"manifold":false,"status":"Not manifold","volume_mm3":null,"surface_area":null,"bbox":null,"triangle_count":10,"components":null,"genus":null}

$ node validate.mjs fixtures/multi-island.stl
{"manifold":true,"status":"NoError","volume_mm3":2000,"surface_area":1200,"bbox":{"min":[0,0,0],"max":[40,10,10]},"triangle_count":24,"components":2,"genus":-1}

$ node validate.mjs fixtures/multi-island.3mf
{"manifold":true,"status":"NoError","volume_mm3":2000,"surface_area":1200,"bbox":{"min":[0,0,0],"max":[40,10,10]},"triangle_count":24,"components":2,"genus":-1}
```

Sanity check: 20mm cube → 20×20×20 = 8000 mm³ exactly, surface area
6×20×20 = 2400 mm² exactly, bbox `[0,0,0]`–`[20,20,20]` — matches. Multi-island
volume 2×1000 = 2000 mm³, surface 2×600 = 1200 mm² — matches two 10mm cubes.
STL and 3MF paths produce bit-identical numeric results on both fixtures they
share, which is expected since both fixtures use only integer-mm geometry.

**Note on `genus` with `components > 1`:** manifold-3d's `genus()` is computed
from the whole mesh's Euler characteristic (χ = 2 − 2g for one closed
orientable surface). For *k* disjoint closed components, combined
χ = 2k, so the reported top-level genus is `1 − k` (here, `1 − 2 = −1`), not a
meaningful topological answer. Confirmed by decomposing and checking each
part individually — both islands report `genus: 0` (a solid cube) as
expected. **Contract implication: only trust the top-level `genus` field when
`components === 1`.**

## INPUT FORMAT DECISION

**Recommendation: run `validate_mesh` on a parallel binary-STL export, not by
parsing 3MF directly.**

Both paths were implemented and evaluated (`lib/stl.mjs` + `lib/mesh-utils.mjs`
for STL; `lib/threemf.mjs` for 3MF, using `jszip` + `fast-xml-parser`), and
`validate.mjs` supports both (dispatched by file extension) for side-by-side
comparison. On both shared fixtures the two paths returned identical
`ValidationReport` fields.

| Axis | Binary STL (recommended) | 3MF (parse directly) |
|---|---|---|
| **Dependency weight** | **0 extra deps.** `lib/stl.mjs` is a ~70-line, dependency-free binary+ASCII STL reader (Node `Buffer` only). | `jszip` (880K) + `fast-xml-parser` (1.3M) ≈ 2.2MB combined, evaluated in `lib/threemf.mjs`. Both MIT-licensed (jszip is dual MIT/GPL-3.0-or-later; MIT branch applies), so no license-boundary conflict with `packages/scad-core` (Apache-2.0 headers required), but still added surface area/supply-chain exposure for a GPL-free package. |
| **Accuracy / topology fidelity** | Needs an explicit vertex-weld step (`weldTriangleSoup`, rounds to 1e-5mm and merges by position) because STL stores fully-duplicated per-triangle vertices with no shared-edge info. Verified correct on all 3 fixtures (good, multi-island, and — critically — the broken mesh still throws `Not manifold` even after welding, so welding does not mask real defects at this tolerance). | Already indexed (`<vertices>`/`<triangle v1 v2 v3>`), no welding needed — marginally higher fidelity by construction, no epsilon choice to defend. |
| **Color handling** | STL carries no color/material data. | 3MF can carry per-object/per-triangle color. **Irrelevant here**: `validate_mesh`'s job (per #6 scope) is purely geometric (manifold/volume/components), not color or printability heuristics (explicitly out of scope, deferred to M3 #33). Color stays the 3MF export's job for rendering/snapshots — this decision does not touch that pipeline. |
| **Render cost** | **Zero extra cost.** OpenSCAD's `-o` flag documents "*May be used multiple time for different exports*" — confirmed empirically: `openscad -o out.3mf -o out.stl model.scad` runs **one** CGAL render and emits both files from the same evaluated geometry. So requesting a parallel STL export alongside the existing 3MF export adds no additional render pass. | N/A (already the export scad-core will produce for other reasons). |
| **Format ambiguity** | STL default is ASCII in OpenSCAD 2021.01 stable (binary planned as future default) — must pass `--export-format=binstl` explicitly, exactly as the pinned-toolchain note in root `CLAUDE.md` already anticipates being made explicit in scripts. Reader here handles both binary and ASCII transparently as a safety net. | 3MF format is unambiguous (always zip+XML). |

**Why STL wins:** the validation-specific ask is purely topological/volumetric,
3MF's only structural advantage (no welding step) didn't change any result on
real fixtures at a sane epsilon, and 3MF's real advantage (color) is out of
scope for this tool. Zero dependency weight for a GPL-free package
(`packages/scad-core`) and zero extra render cost make binary STL the lower-risk
default. Keep 3MF as the export scad-core already produces for rendering/color;
just also request `-o validate.stl` from the same OpenSCAD invocation
specifically for the `validate_mesh` tool call.

## Proposed `ValidationReport` type (for `packages/scad-core/src/types.ts` / `packages/agent/src/tools/contract.ts`)

```typescript
export type ManifoldStatus =
  | 'NoError'
  | 'NonFiniteVertex'
  | 'NotManifold'
  | 'VertexOutOfBounds'
  | 'PropertiesWrongLength'
  | 'MissingPositionProperties'
  | 'MergeVectorsDifferentLengths'
  | 'MergeIndexOutOfBounds'
  | 'TransformWrongLength'
  | 'RunIndexWrongLength'
  | 'FaceIDWrongLength'
  | 'InvalidConstruction'
  | 'ResultTooLarge'
  | 'InvalidTangents'
  | 'Cancelled'
  // Not a manifold-3d status; set when Manifold construction throws outright
  // (e.g. the mesh is not an oriented 2-manifold at all) rather than
  // returning a queryable handle with a non-NoError status.
  | 'ConstructionFailed';

export interface ValidationReport {
  /** True iff status === 'NoError' and the mesh is non-empty. */
  manifold: boolean;
  /** manifold-3d's status(), or 'ConstructionFailed' — see ManifoldStatus. */
  status: ManifoldStatus;
  /** null when manifold is false (no valid solid to measure). */
  volume_mm3: number | null;
  surface_area: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Raw input triangle count (present even when manifold is false). */
  triangle_count: number;
  /** Count of disconnected solid components (via decompose().length). null when manifold is false. */
  components: number | null;
  /**
   * Euler-characteristic-derived genus of the WHOLE mesh. Only meaningful
   * when components === 1 -- see README note above. null when manifold is
   * false or components > 1.
   */
  genus: number | null;
}
```

### Suggested thresholds for `contract.ts` (validate_mesh gating)

- `manifold === true` — **hard gate**. `export` refuses without explicit
  override per root `CLAUDE.md` rule 7.
- `volume_mm3 > 0.001` (i.e. reject degenerate/zero-volume solids) — hard
  gate; a manifold mesh can still have ~0 volume from cancelling geometry.
- `components === 1` — **default hard gate**, but must be an *overridable*
  option (`allowMultiPart?: boolean`) since some legitimate models are
  intentional multi-body exports (e.g. assemblies with separate parts by
  design). When `allowMultiPart` is set, downgrade to a warning and skip the
  `genus` threshold (see above).
- `genus` — informational only; no default gate. Surface it in the UI as a
  hint (nonzero genus = has holes/handles) rather than a pass/fail signal.
- `bbox` — no absolute threshold (unit-agnostic), but agent/tool layer should
  sanity-check the requested part's expected scale (mm) against bbox extents
  to catch e.g. accidental 1000x scale-unit errors — left as a scad-core UX
  concern, not a validate_mesh contract field.

## GO

## Decisions for PROJECT_CONTEXT.md

- **validate_mesh input format**: parallel binary-STL export (`-o out.stl`
  alongside the existing `-o out.3mf`, same OpenSCAD invocation/CGAL render —
  zero extra render cost). Not 3MF-direct-parse (saves ~2.2MB deps in a
  GPL-free package; color is irrelevant to geometric validation).
- **manifold-3d API surface used**: `new Mesh({numProp, vertProperties,
  triVerts})` → `new Manifold(mesh)` (throws `Not manifold` on invalid
  topology — catch, don't rely on `.status()` for that case) →
  `.status()`, `.isEmpty()`, `.volume()`, `.surfaceArea()`, `.boundingBox()`,
  `.numTri()`, `.decompose().length` (components), `.genus()`.
- **STL vertex welding required**: STL triangle-soup must be welded to
  shared-index topology before handing to manifold-3d (epsilon 1e-5mm here);
  a zero-dependency welder is implemented in `lib/mesh-utils.mjs`.
- **Genus caveat**: top-level `genus` is only meaningful when
  `components === 1` (Euler-characteristic artifact for multi-component
  meshes: reported genus becomes `1 - componentCount`).
- **ValidationReport shape**: as proposed above — adopt for the #10 contract
  freeze, in `packages/scad-core/src/types.ts` and referenced from
  `packages/agent/src/tools/contract.ts`'s `validate_mesh` tool result.
