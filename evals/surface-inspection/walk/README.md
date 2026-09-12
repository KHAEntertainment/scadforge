# S2-6 human walk runbook

The human-walk half of [S2-6](../../../.traycer/epics/ca1c7904-3e6c-4a5e-a4fd-09d50c993053/artifacts/combined-measurement-editor-plan/s2-surface-inspection-scope/tickets/s2-6-qualification-walk/index.md)
(the timing half lives in `../timing/`). Needs the running app — S2-4
(viewer click picking) and S2-5 (Inspect toggle + readout), both landed
(`097b630` for S2-5) — so it can actually be walked now.

**Expected-readout wording:** taken from a real capture of the app
(clamp, wall 3) plus [S2-5's own spec](../../../.traycer/epics/ca1c7904-3e6c-4a5e-a4fd-09d50c993053/artifacts/combined-measurement-editor-plan/s2-surface-inspection-scope/tickets/s2-5-inspect-readout/index.md)
for what doesn't vary by fixture:
- Title: `Hole · Ø {d} mm` / `Outside · Ø {d} mm` (`formatMm` drops the
  decimal for a whole number — `Ø 32 mm`, not `Ø 32.00 mm`).
- Detail: `Axis {X|Y|Z} · center ({x}, {y}, {z}) · length {len} mm`.
- Provenance: `Measured from snapshot {id} · circle fit over {segments}
  segments, {arc}°, max deviation {dev} mm` — write `<id>` for the
  snapshot id below since it's assigned when you seed the project, not
  something to predict. `segments`/`arc`/`dev` are exact for every row
  except `outer_ring`'s `arc`/`dev`, which are real-render numbers not
  independently re-measured for this walk (a real capture at wall=3 showed
  315.1° and 0.008 mm — both inside "partial, well under 0.01mm").
- Then `Editable: no binding`, a disabled **Set up manually** button, and
  the note "Setup arrives with the editor." — recognized rows only, no
  "Editable" line on a refusal.
- Refused rows: the verbatim `refusal.message`, then the same disabled
  **Set up manually** + note, no "Editable" line.
- `data-testid="inspect-toggle"` (`aria-pressed`) for the toggle,
  `data-testid="inspect-readout"` for the readout, if you need to find
  either in devtools.

Diameters/axes/centers/lengths themselves are exact for every row — pulled
straight from `evals/surface-inspection/fixture/{clamp,hinge}.expected.json`
plus the fixtures' own closed-form geometry; refusal messages are exact
from `apps/web/src/components/inspect/refusals.ts`.

**Known quirk:** the 3D canvas can start at 300×150px until its
`ResizeObserver` catches up, which can make early clicks land on the wrong
thing. If clicks seem to miss, switch to a fixed (e.g. Front) view and back
to 3D before inspecting.

## Starting the app

```bash
# 1. Build everything once (needed for the server; the web dev server builds on the fly).
pnpm -r build

# 2. Start the server (separate terminal). Default port 3001; project data
#    lands under .scadforge/ (CLAUDE.md hard rule 9 — no database).
pnpm --filter @scadforge/server start

# 3. Start the web dev server (separate terminal). Default port 5173,
#    proxies /api to localhost:3001 (apps/web/vite.config.ts).
pnpm --filter @scadforge/web dev
```

Docker (the pinned OpenSCAD image) must be running — every build/render in
the walk goes through it, same as the fixture tests.

## Seeding the 6 walk projects

```bash
node evals/surface-inspection/walk/seed-projects.mjs
```

Creates (or, on a rerun, reuses — matched by name, so this is safe to run
more than once) 6 projects through the real REST API — the same
create → set params → build flow the app itself uses:

| Project name | Source | Params |
| --- | --- | --- |
| `S2 walk · clamp wall2` | `evals/scenario-a2/fixture/clamp.scad` | `wall = 2` |
| `S2 walk · clamp wall4` | `evals/scenario-a2/fixture/clamp.scad` | `wall = 4` |
| `S2 walk · clamp wall6` | `evals/scenario-a2/fixture/clamp.scad` | `wall = 6` |
| `S2 walk · hinge low` | `evals/surface-inspection/fixture/hinge.scad` | `pin_d = 3, knuckle_wall = 1.5` |
| `S2 walk · hinge mid` | `evals/surface-inspection/fixture/hinge.scad` | `pin_d = 4.5, knuckle_wall = 2` |
| `S2 walk · hinge high` | `evals/surface-inspection/fixture/hinge.scad` | `pin_d = 6, knuckle_wall = 3.5` |

Set `SCADFORGE_API_URL` if the server isn't on the default
`http://localhost:3001`. The script prints each project's id; open each by
its **name** in the app (Projects list) for the walk below.

## Walking every row

For each project: open it, turn **Inspect** on (3D/orbit view — Inspect is
disabled in Live mode and on the PNG views), and work down its table.
Every row's click target and expected outcome came straight from the same
fixture rays already verified against the real rendered mesh in
`evals/surface-inspection/fixture/`. Record Pass/Fail and any discrepancy
in the Notes column — don't fix anything found here except a trivial,
S2-file-only defect that you then re-walk (S2-6 scope: report and follow
up otherwise, don't fix in this ticket).

**Keyboard steps (Esc) were verified using native computer-use input.** Earlier automation
ownership blocked real keyboard input in S0 iteration 3; the recovered native
control path used in this walk successfully delivered a trusted Escape keydown.

**Track `too-coarse` frequency** as you go: this fires only on the hex
boss in both fixtures (`hex_boss_slanted`) — count how many times you see
it across all 6 projects and note it at the bottom of this file once
walked (decided question 1, scope §Risks 1: this tells the owner whether
the segment-count threshold needs revisiting from real usage, not from
guessing).

<!-- WALK_TABLE_START -->
<!-- Generated from evals/surface-inspection/fixture/{hinge,clamp}.expected.json — see the git history of this file for the generator, or regenerate by hand from those two files if the fixtures ever change. -->


#### hinge / low (pin_d=3, knuckle_wall=1.5) — project "S2 walk · hinge low"

| Feature | Click target | Outcome | Expected readout / message | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
| `knuckle_bore_x-16` | Left knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 3 mm**<br>Axis X · center (-16, 2, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_bore_x0` | Middle knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 3 mm**<br>Axis X · center (0, 2, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_bore_x16` | Right knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 3 mm**<br>Axis X · center (16, 2, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x-16` | Left knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 6 mm**<br>Axis X · center (-16, 2, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 263.9°, max deviation 0.005 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x0` | Middle knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 6 mm**<br>Axis X · center (0, 2, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 263.9°, max deviation 0.005 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x16` | Right knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 6 mm**<br>Axis X · center (16, 2, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 263.9°, max deviation 0.005 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `countersink_straight` | The countersunk hole (not the hex boss) — click its straight lower wall, below the cone | Recognized | **Hole · Ø 4 mm**<br>Axis Z · center (-12, -8, 2.5) · length 5 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `countersink_cone` | The countersunk hole — click the sloped cone part near the top | Refused (not-axis-aligned) | **This surface isn't a cylinder aligned with the X, Y or Z axis.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `hex_boss_slanted` | The six-sided boss — click one of its angled side faces | Refused (too-coarse) | **This curve has only 6 segments — too few to tell a cylinder from a polygonal prism. Raise $fn for this feature to inspect it.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `hex_boss_axis_aligned` | The six-sided boss — click the one side face that sits square-on to the leaf's long edge | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `stadium_slot` | The pill-shaped slot — click its rounded left end | Refused (not-circular) | **These facets don't fit a single circle (off by up to {dev} mm), so no diameter is shown.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `leaf_top_face` | The flat top of the leaf, away from every other feature | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |

#### hinge / mid (pin_d=4.5, knuckle_wall=2) — project "S2 walk · hinge mid"

| Feature | Click target | Outcome | Expected readout / message | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
| `knuckle_bore_x-16` | Left knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (-16, 3.3, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_bore_x0` | Middle knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (0, 3.3, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_bore_x16` | Right knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (16, 3.3, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x-16` | Left knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 8.5 mm**<br>Axis X · center (-16, 3.3, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 280°, max deviation 0.007 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x0` | Middle knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 8.5 mm**<br>Axis X · center (0, 3.3, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 280°, max deviation 0.007 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x16` | Right knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 8.5 mm**<br>Axis X · center (16, 3.3, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 280°, max deviation 0.007 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `countersink_straight` | The countersunk hole (not the hex boss) — click its straight lower wall, below the cone | Recognized | **Hole · Ø 4 mm**<br>Axis Z · center (-12, -8, 2.5) · length 5 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `countersink_cone` | The countersunk hole — click the sloped cone part near the top | Refused (not-axis-aligned) | **This surface isn't a cylinder aligned with the X, Y or Z axis.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `hex_boss_slanted` | The six-sided boss — click one of its angled side faces | Refused (too-coarse) | **This curve has only 6 segments — too few to tell a cylinder from a polygonal prism. Raise $fn for this feature to inspect it.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `hex_boss_axis_aligned` | The six-sided boss — click the one side face that sits square-on to the leaf's long edge | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `stadium_slot` | The pill-shaped slot — click its rounded left end | Refused (not-circular) | **These facets don't fit a single circle (off by up to {dev} mm), so no diameter is shown.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `leaf_top_face` | The flat top of the leaf, away from every other feature | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |

#### hinge / high (pin_d=6, knuckle_wall=3.5) — project "S2 walk · hinge high"

| Feature | Click target | Outcome | Expected readout / message | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
| `knuckle_bore_x-16` | Left knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 6 mm**<br>Axis X · center (-16, 5.5, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_bore_x0` | Middle knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 6 mm**<br>Axis X · center (0, 5.5, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_bore_x16` | Right knuckle — click inside its bore (the hole through it), from the side | Recognized | **Hole · Ø 6 mm**<br>Axis X · center (16, 5.5, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x-16` | Left knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 13 mm**<br>Axis X · center (-16, 5.5, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 295.9°, max deviation 0.009 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x0` | Middle knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 13 mm**<br>Axis X · center (0, 5.5, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 295.9°, max deviation 0.009 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `knuckle_outside_x16` | Right knuckle — click its round outer surface, from the side | Recognized | **Outside · Ø 13 mm**<br>Axis X · center (16, 5.5, 4) · length 10 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 295.9°, max deviation 0.009 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `countersink_straight` | The countersunk hole (not the hex boss) — click its straight lower wall, below the cone | Recognized | **Hole · Ø 4 mm**<br>Axis Z · center (-12, -8, 2.5) · length 5 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `countersink_cone` | The countersunk hole — click the sloped cone part near the top | Refused (not-axis-aligned) | **This surface isn't a cylinder aligned with the X, Y or Z axis.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `hex_boss_slanted` | The six-sided boss — click one of its angled side faces | Refused (too-coarse) | **This curve has only 6 segments — too few to tell a cylinder from a polygonal prism. Raise $fn for this feature to inspect it.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `hex_boss_axis_aligned` | The six-sided boss — click the one side face that sits square-on to the leaf's long edge | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `stadium_slot` | The pill-shaped slot — click its rounded left end | Refused (not-circular) | **These facets don't fit a single circle (off by up to {dev} mm), so no diameter is shown.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `leaf_top_face` | The flat top of the leaf, away from every other feature | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |

#### clamp / wall2 (wall=2) — project "S2 walk · clamp wall2"

| Feature | Click target | Outcome | Expected readout / message | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
| `pipe_bore` | The big central bore (the pipe hole) | Recognized | **Hole · Ø 32 mm**<br>Axis Z · center (0, 0, 0) · length 20 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `outer_ring` | The outer cylindrical surface of the ring, on the side away from the backplate | Recognized | **Outside · Ø 36 mm**<br>Axis Z · center (0, 0, 0) · length 20 mm<br>Measured from snapshot <id> · circle fit over 48 segments, ≈300–330° (partial — the backplate blocks part of it; a real capture at wall=3 showed 315.1°), max deviation small (a real capture at wall=3 showed 0.008 mm)<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `screw_hole_backplate_dy-1` | One of the two backplate screw holes (the lower one) — click inside it | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (-19, -9, 0) · length 4 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `screw_hole_backplate_dy1` | The other backplate screw hole (the upper one) — click inside it | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (-19, 9, 0) · length 4 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `backplate_face` | The flat back face of the backplate | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `ring_end_cap` | The flat top face of the ring, off to the side of the bore | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |

#### clamp / wall4 (wall=4) — project "S2 walk · clamp wall4"

| Feature | Click target | Outcome | Expected readout / message | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
| `pipe_bore` | The big central bore (the pipe hole) | Recognized | **Hole · Ø 32 mm**<br>Axis Z · center (0, 0, 0) · length 20 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `outer_ring` | The outer cylindrical surface of the ring, on the side away from the backplate | Recognized | **Outside · Ø 40 mm**<br>Axis Z · center (0, 0, 0) · length 20 mm<br>Measured from snapshot <id> · circle fit over 48 segments, ≈300–330° (partial — the backplate blocks part of it; a real capture at wall=3 showed 315.1°), max deviation small (a real capture at wall=3 showed 0.008 mm)<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `screw_hole_backplate_dy-1` | One of the two backplate screw holes (the lower one) — click inside it | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (-21, -10, 0) · length 4 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `screw_hole_backplate_dy1` | The other backplate screw hole (the upper one) — click inside it | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (-21, 10, 0) · length 4 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `backplate_face` | The flat back face of the backplate | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `ring_end_cap` | The flat top face of the ring, off to the side of the bore | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |

#### clamp / wall6 (wall=6) — project "S2 walk · clamp wall6"

| Feature | Click target | Outcome | Expected readout / message | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
| `pipe_bore` | The big central bore (the pipe hole) | Recognized | **Hole · Ø 32 mm**<br>Axis Z · center (0, 0, 0) · length 20 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `outer_ring` | The outer cylindrical surface of the ring, on the side away from the backplate | Recognized | **Outside · Ø 44 mm**<br>Axis Z · center (0, 0, 0) · length 20 mm<br>Measured from snapshot <id> · circle fit over 48 segments, ≈300–330° (partial — the backplate blocks part of it; a real capture at wall=3 showed 315.1°), max deviation small (a real capture at wall=3 showed 0.008 mm)<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `screw_hole_backplate_dy-1` | One of the two backplate screw holes (the lower one) — click inside it | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (-23, -11, 0) · length 4 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `screw_hole_backplate_dy1` | The other backplate screw hole (the upper one) — click inside it | Recognized | **Hole · Ø 4.5 mm**<br>Axis X · center (-23, 11, 0) · length 4 mm<br>Measured from snapshot <id> · circle fit over 48 segments, 360°, max deviation 0.000 mm<br>Editable: no binding · "Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `backplate_face` | The flat back face of the backplate | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |
| `ring_end_cap` | The flat top face of the ring, off to the side of the bore | Refused (planar) | **This is a flat surface. Surface inspection measures cylindrical walls only.**<br>"Set up manually" (disabled) · "Setup arrives with the editor." | Pass | Native click; see S2 results artifact (2026-09-12). |

<!-- WALK_TABLE_END -->

## Clearing checks

Walk these once, on any one project with a recognized result currently
showing (e.g. `S2 walk · clamp wall2`'s `pipe_bore`):

| Check | Steps | Expected | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| Esc | Inspect a surface, press Esc (Traycer manual tab control — see above) | Selection and readout clear | Pass | Native recovery walk 2026-09-12; History/snapshot share one UI path. |
| Empty click | Inspect a surface, click empty space in the viewport | Selection and readout clear | Pass | Native recovery walk 2026-09-12; History/snapshot share one UI path. |
| Snapshot change | Inspect a surface, select a different snapshot in History | Selection and readout clear | Pass | Native recovery walk 2026-09-12; History/snapshot share one UI path. |
| History selection | Same as above, from the History panel specifically (if distinct from a snapshot click in-viewer) | Selection and readout clear | Pass | Native recovery walk 2026-09-12; History/snapshot share one UI path. |
| Project switch | Inspect a surface, switch to a different project | Selection and readout clear | Pass | Native recovery walk 2026-09-12; History/snapshot share one UI path. |
| Live mode | Inspect a surface, switch the view to Live | Inspect toggle disables, selection and readout clear | Pass | Native recovery walk 2026-09-12; History/snapshot share one UI path. |

## `too-coarse` tally (decided question 1)

Fires on `hex_boss_slanted` in the 3 hinge projects. The 3 clamp projects have no hex boss.
Record here once walked:

- Expected hex-boss rows producing `too-coarse`: **3 / 3 hinge projects**; none in the clamp projects.
- Any occurrence NOT on the hex boss (would be a genuine finding, not
  expected by any fixture row above): **None in this native walk.**

## Desktop readout regression check (2026-09-12)

The qualification walk exposed page growth when a readout appeared. Bounding the
desktop app height lets the canvas shrink to make room. Native wall6 outside-wall
and flat-backplate selections verified recognized and refused results:

| Viewport (CSS px) | Recognized readout top–bottom | Refused readout top–bottom | Result |
| --- | --- | --- | --- |
| 1534 × 1291 | 1131–1248 | 1170–1248 | Pass |
| 1280 × 800 | 640–757 | 679–757 | Pass |
| 1366 × 768 | 608–725 | 647–725 | Pass |

In every case the document matched the viewport dimensions, both scroll offsets
were zero, the toolbar remained visible, and the full readout, disabled setup
button, note and validation panel fit. The recognized result included snapshot
0002 provenance and `Editable: no binding`. The original viewport was restored.
