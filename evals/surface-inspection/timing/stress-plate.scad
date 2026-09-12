// Surface-inspection timing fixture — a stress plate (S2-6).
//
// Hand-authored, same rationale as evals/scenario-a2/fixture/clamp.scad:
// this is timing DATA, reproducible run over run, not agent output. Its
// only purpose is triangle count: the fixture-derived meshes in
// evals/surface-inspection/fixture/ (1,000-2,400 triangles) only tell the
// S2-6 timing budget about small meshes. A grid of $fn = 48 through-holes
// plus a handful of cylindrical bosses on one plate gets well past that,
// at a size a real bracket-with-many-fasteners part could plausibly reach.
//
// Properties the harness relies on:
//   - one fused solid (components == 1): the bosses sit flush on the
//     plate's own top face (embedded 0.5mm in, same trick as the hinge's
//     hex boss) and every hole is a plain through-cut, so nothing can
//     detach the plate into separate pieces;
//   - hole_cols * hole_rows through-holes, d = hole_d, on a uniform grid,
//     inset hole_margin from every edge — the bulk of the triangle count;
//   - boss_cols * boss_rows solid cylindrical bosses, d = boss_d, on a
//     coarser grid offset by half the hole pitch so no boss is centered on
//     a hole;
//   - triangle count is empirical (CSG boolean seams add real, non-trivial
//     facets beyond the naive "features x $fn" estimate — verified against
//     the pinned engine, not computed from a formula) — see
//     evals/surface-inspection/timing/README.md for the measured count.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/* [Plate] */
// Plate length, X (mm)
plate_len = 260;    // [100:10:400]
// Plate width, Y (mm)
plate_wid = 170;    // [100:10:400]
// Plate thickness, Z (mm)
plate_thick = 6;    // [3:1:12]

/* [Holes] */
// Hole grid columns
hole_cols = 26;     // [5:1:80]
// Hole grid rows
hole_rows = 20;     // [5:1:80]
// Hole diameter (mm)
hole_d = 4;         // [2:0.5:8]
// Margin from plate edge to the outermost hole row/column (mm)
hole_margin = 12;   // [5:1:30]

/* [Bosses] */
// Boss grid columns (coarser than the hole grid; offset by half the hole pitch)
boss_cols = 5;      // [2:1:12]
// Boss grid rows
boss_rows = 3;      // [2:1:12]
// Boss diameter (mm)
boss_d = 10;        // [4:0.5:20]
// Boss height above the plate's top face (mm)
boss_h = 8;         // [3:1:20]

/* [Quality] */
$fn = 48;           // [24:8:96]

// ---- Helpers ----

hole_pitch_x = (plate_len - 2 * hole_margin) / (hole_cols - 1);
hole_pitch_y = (plate_wid - 2 * hole_margin) / (hole_rows - 1);

// Bosses sit on a grid inset a bit further than the holes, offset by half
// a hole pitch in each axis so no boss lands centered on a hole.
boss_pitch_x = (plate_len - 2 * hole_margin) / (boss_cols - 1);
boss_pitch_y = (plate_wid - 2 * hole_margin) / (boss_rows - 1);
boss_offset_x = hole_pitch_x / 2;
boss_offset_y = hole_pitch_y / 2;

// ---- Geometry ----

module plate() {
  translate([-plate_len / 2, -plate_wid / 2, 0])
    cube([plate_len, plate_wid, plate_thick]);
}

module holes() {
  for (i = [0:hole_cols - 1])
    for (j = [0:hole_rows - 1]) {
      x = -plate_len / 2 + hole_margin + i * hole_pitch_x;
      y = -plate_wid / 2 + hole_margin + j * hole_pitch_y;
      // 1mm overhang past both faces for a clean through-cut.
      translate([x, y, -1])
        cylinder(h = plate_thick + 2, d = hole_d);
    }
}

module bosses() {
  for (i = [0:boss_cols - 1])
    for (j = [0:boss_rows - 1]) {
      x = -plate_len / 2 + hole_margin + boss_offset_x + i * boss_pitch_x;
      y = -plate_wid / 2 + hole_margin + boss_offset_y + j * boss_pitch_y;
      // Embedded 0.5mm into the plate for a real union overlap, same
      // convention as the hinge fixture's hex boss.
      translate([x, y, plate_thick - 0.5])
        cylinder(h = boss_h + 0.5, d = boss_d);
    }
}

module stress_plate() {
  difference() {
    union() {
      plate();
      bosses();
    }
    holes();
  }
}

stress_plate();
