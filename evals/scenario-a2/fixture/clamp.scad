// Scenario A2 fixture — a wall-mount pipe clamp (Issue #35).
//
// This is a HAND-AUTHORED fixture, deliberately not agent output: the
// preview/server agreement measurement has to be reproducible run over run,
// and a model the agent re-authors each time would make a divergence
// impossible to attribute. It follows the same conventions the agent's system
// prompt demands (mm, Customizer annotations, parameters first, helpers
// second, geometry last) so the Params tab and `--export-format=param` see a
// realistic schema.
//
// Properties the harness relies on:
//   - one fused solid (components == 1) so the export validation gate passes;
//   - genus 3 (bore + two screw holes) so the comparison covers real topology,
//     not just a convex blob;
//   - volume strictly INCREASING in `wall`, and outer bbox growing by exactly
//     1mm per axis per 1mm of `wall` — both checkable in closed form;
//   - the backplate overlaps the clamp ring by 1mm at every legal `wall`, so
//     the union never degenerates into two touching-but-disjoint bodies.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/* [Clamp] */
// Pipe outside diameter (mm)
pipe_dia = 32;   // [10:1:80]
// Clamp wall thickness (mm)
wall = 3;        // [1:0.5:10]
// Bracket width along the pipe axis (mm)
width = 20;      // [8:1:60]

/* [Backplate] */
// Backplate thickness (mm)
plate = 4;       // [2:0.5:12]
// Screw hole diameter (mm)
screw_dia = 4.5; // [2:0.1:8]

/* [Quality] */
// Facets per full circle
$fn = 48;        // [24:8:96]

outer_r = pipe_dia / 2 + wall;
plate_h = pipe_dia + 2 * wall;

module clamp() {
  difference() {
    union() {
      cylinder(h = width, r = outer_r, center = true);
      // -plate/2 + 1 keeps a 1mm overlap with the ring at every `wall`.
      translate([-outer_r - plate / 2 + 1, 0, 0])
        cube([plate, plate_h, width], center = true);
    }
    // Pipe bore, run past both faces so it reads as a through-hole.
    cylinder(h = width + 2, d = pipe_dia, center = true);
    // Two screw holes through the backplate, along X.
    for (dy = [-1, 1])
      translate([-outer_r - plate, dy * plate_h / 4, 0])
        rotate([0, 90, 0])
          cylinder(h = plate + 4, d = screw_dia, center = false);
  }
}

clamp();
