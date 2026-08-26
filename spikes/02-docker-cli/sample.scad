// ScadForge Spike 2 — sample model
// A mid-size BOSL2 part: a wall-mount pipe bracket with two screw slots
// (mirrors SDP §3 Scenario A). Exercises cuboid/tube/rounding, color(),
// and Customizer parameter annotations for --export-format=param.

include <libs/BOSL2/std.scad>

/* [Pipe] */
// Outer diameter of the pipe the bracket clamps
pipe_d = 32; // [10:1:80]
// Bracket wall thickness
wall = 4; // [2:0.5:10]
// Bracket depth (along the pipe axis)
depth = 24; // [10:1:60]

/* [Mount] */
// Length of each mounting slot
slot_len = 10; // [5:1:20]
// Diameter of the mounting screw
screw_d = 4; // [3:0.5:8]
// Back plate thickness
back_t = 5; // [3:0.5:12]

/* [Render] */
// Facet count for curved surfaces
smooth_fn = 48; // [16:8:128]

$fn = smooth_fn;

clamp_id = pipe_d;
clamp_od = pipe_d + 2 * wall;
back_w = clamp_od + 12;
back_h = depth + 12;

module back_plate() {
  color("SteelBlue")
  difference() {
    cuboid([back_w, back_h, back_t], rounding=2, edges="Z", anchor=CENTER);
    for (sx = [-1, 1])
      translate([sx * (back_w / 2 - screw_d - slot_len / 2), 0, 0])
        linear_extrude(height = back_t + 2, center = true)
          rect([slot_len, screw_d * 1.2], rounding = screw_d * 0.55);
  }
}

module pipe_clamp() {
  color("SteelBlue")
  translate([0, 0, back_t / 2])
    difference() {
      tube(h = depth, id = clamp_id, od = clamp_od, anchor = BOTTOM);
      // open gap at the top so the clamp can flex over the pipe
      translate([0, clamp_od / 2, depth / 2])
        cuboid([clamp_od * 0.3, clamp_od, depth + 2], anchor = CENTER);
    }
}

// A second color()'d part so the 3MF color-survival check has >1 material.
module clamp_screw_caps() {
  color("Goldenrod")
    for (sx = [-1, 1])
      translate([sx * (back_w / 2 - screw_d - slot_len / 2), 0, back_t / 2 + 3])
        cyl(h = 6, d = screw_d * 2, rounding = 1, anchor = BOTTOM, $fn = 24);
}

back_plate();
pipe_clamp();
clamp_screw_caps();
