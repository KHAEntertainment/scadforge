// THROWAWAY spike model (Issue #3): ~50-line BOSL2 part used for all
// timing measurements. Rounded cuboid base + four rounded corner posts +
// a couple of cylindrical holes, all via BOSL2 primitives — enough
// geometry to exercise attachments, rounding and boolean CSG without
// being a slow render.
export const BOSL2_MODEL_SCAD = `
include <BOSL2/std.scad>

$fn = 32;

// [Section: Base plate]
plate_w = 60;   // [20:200]
plate_d = 40;   // [20:200]
plate_h = 6;    // [2:20]
corner_r = 4;   // [0:10]

// [Section: Posts]
post_d = 8;     // [2:20]
post_h = 18;    // [4:60]
post_r = 1.5;   // [0:5]

module base_plate() {
  cuboid([plate_w, plate_d, plate_h], rounding = corner_r, edges = "Z", anchor = BOTTOM) {
    // Two mounting holes through the plate, positioned via attach().
    attach(TOP, BOTTOM, overlap = plate_h)
      position(FRONT + LEFT) up(plate_h / 4)
        cyl(d = 3.5, h = plate_h * 2, anchor = CENTER, orient = UP);
  }
}

module corner_post(x_sign, y_sign) {
  translate([x_sign * (plate_w / 2 - post_d), y_sign * (plate_d / 2 - post_d), plate_h])
    cyl(d = post_d, h = post_h, rounding2 = post_r, anchor = BOTTOM);
}

module holes() {
  for (x = [-1, 1])
    for (y = [-1, 1])
      translate([x * (plate_w / 2 - post_d), y * (plate_d / 2 - post_d), -0.5])
        cyl(d = post_d * 0.5, h = plate_h + 1, anchor = BOTTOM);
}

diff("holes")
  base_plate() {
    tag("holes") holes();
    for (x = [-1, 1])
      for (y = [-1, 1])
        corner_post(x, y);
  }
`;
