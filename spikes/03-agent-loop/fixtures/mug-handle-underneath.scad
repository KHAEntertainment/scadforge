// Deterministic "visual-only defect" fixture for spike 3.
//
// This is a coffee mug whose loop handle is fused to the UNDERSIDE of the base
// instead of the side wall. It is a single, watertight, manifold solid with one
// connected component, so `validate_mesh` reports it as completely clean.
// The defect is visible ONLY in the rendered image — which is exactly what the
// image tool-result path has to be good for.

/* [Cup] */
cup_outer_d   = 80;   // [40:120]
cup_height    = 95;   // [40:160]
wall          = 4;    // [2:8]
base          = 6;    // [3:12]

/* [Handle] */
handle_loop_r = 44;   // [15:70]
handle_bar_d  = 12;   // [5:20]
handle_embed  = 0;    // [0:8]

/* [Quality] */
$fn = 64;             // [16:8:128]

module cup() {
    difference() {
        cylinder(h = cup_height, d = cup_outer_d);
        translate([0, 0, base])
            cylinder(h = cup_height, d = cup_outer_d - 2 * wall);
    }
}

module handle() {
    difference() {
        cylinder(h = handle_bar_d, r = handle_loop_r + handle_bar_d / 2);
        translate([0, 0, -1])
            cylinder(h = handle_bar_d + 2, r = handle_loop_r - handle_bar_d / 2);
    }
}

union() {
    cup();
    // DEFECT: the handle loop lies flat around the bottom of the cup like a
    // skirt, instead of standing vertically against the side wall.
    translate([0, 0, handle_embed])
        handle();
}
