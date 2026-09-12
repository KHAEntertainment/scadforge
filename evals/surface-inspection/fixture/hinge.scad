// Surface-inspection fixture — a three-knuckle butt hinge leaf (S2-3).
//
// This is a HAND-AUTHORED fixture, not agent output — same rationale as
// `evals/scenario-a2/fixture/clamp.scad`: cylindrical-surface recognition has
// to be tested against a reproducible closed-form model, not something an
// agent re-authors run to run. It follows the clamp's conventions (mm,
// Customizer annotations, parameters first, helpers second, geometry last)
// and adds a SECOND, topologically distinct fixture: knuckles along X instead
// of a bore along Z, a countersink whose cone must refuse while its straight
// wall recognizes, an intentionally too-coarse hex boss, and a stadium slot
// whose tangent flats must refuse as non-circular. `pin_d` and `knuckle_wall`
// are the only dimensions that vary across the test samples; every other
// dimension below is a fixed constant chosen to keep the fused-solid and
// feature-isolation proofs true for ANY legal `pin_d`/`knuckle_wall` pair.
//
// Properties the harness relies on:
//   - one fused solid (components == 1) at every legal `pin_d`/`knuckle_wall`
//     pair. Each knuckle overlaps the leaf by exactly 1mm regardless of the
//     knuckle radius `r = pin_d/2 + knuckle_wall` (the clamp's overlap trick:
//     the knuckle's axis sits at `y = r - 1`, so its near edge is always at
//     `y = -1`, 1mm inside the leaf slab which spans `y ∈ [-leaf_width, 0]`);
//   - the bore never touches the leaf slab at any legal value: the bore's
//     near edge sits at `y = knuckle_wall - 1`, independent of `pin_d`, and
//     `knuckle_wall >= 1.5` keeps that >= 0.5mm on the positive (leaf-facing)
//     side of `y = 0` — the bore only ever removes knuckle material;
//   - three coaxial knuckle bores, `d = pin_d`, separated by real `gap`s along
//     X, so each is its own surface region (a genus-raising, not just convex,
//     topology, unlike the clamp's single Z bore);
//   - knuckle outside diameter `pin_d + 2 * knuckle_wall`, coaxial with the
//     bore, so hole/outside classification has a real pair to distinguish;
//   - the countersunk mounting hole's straight cylindrical wall is
//     `leaf_thick - cs_depth = 5mm` — fixed, since neither `leaf_thick` nor
//     `cs_depth` depends on `pin_d`/`knuckle_wall` — comfortably over the 2mm
//     the harness requires to click it apart from the cone;
//   - the hex boss is `$fn = 6`; every other solid renders at `$fn = 48`;
//   - the stadium slot is a `hull()` of two same-height, Z-axis cylinders, so
//     its two arcs and two flats are one C1-continuous vertical surface —
//     there is no sharp edge between an arc and a flat for region growth to
//     stop at, so the whole slot wall is one region no circle fits;
//   - the three added features (countersink, hex boss, slot) sit on the flat
//     leaf face at `y = -leaf_width / 2 = -8`, at least 3mm clear of the
//     knuckle-overlap sliver (`y ∈ [-1, 0]`) and of each other and the leaf
//     edges, independent of `pin_d`/`knuckle_wall` (none of their placement
//     or size depends on either);
//   - closed-form bbox as a function of `r = pin_d/2 + knuckle_wall`:
//       x: [-21, 21]                         (constant — knuckle_len/gap/leaf
//                                              length never vary)
//       y: [-16, 2r - 1]                     (min constant; max grows with r)
//       z: [min(0, 4 - r), 14]               (max constant — the hex boss
//                                              always tops out higher than the
//                                              tallest knuckle in-range; min
//                                              drops below 0 once r > 4)
//
// SPDX-License-Identifier: GPL-3.0-or-later

/* [Hinge] */
// Knuckle bore / pin diameter, through all three knuckles (mm)
pin_d = 4.5;        // [3:0.5:6]
// Knuckle wall thickness around the bore (mm)
knuckle_wall = 2;   // [1.5:0.5:3.5]

/* [Quality] */
// Facets per full circle (everything except the hex boss, which is fixed $fn = 6)
$fn = 48;           // [24:8:96]

// ---- Helpers (fixed constants; none of these vary across test samples) ----

// Knuckle layout along X: length of each knuckle and the real gap between them.
knuckle_len = 10;
gap = 6;
// Total leaf length along X, and the three knuckle centers it implies.
leaf_len = 3 * knuckle_len + 2 * gap;          // 42
knuckle_x = [-(knuckle_len + gap), 0, (knuckle_len + gap)]; // [-16, 0, 16]

// Leaf slab: x spans leaf_len, y is the leaf's depth, z is its thickness.
leaf_width = 16;
leaf_thick = 8;

// Knuckle geometry, derived from the two real parameters.
knuckle_r = pin_d / 2 + knuckle_wall;           // outside radius
knuckle_y = knuckle_r - 1;                      // axis Y: always 1mm overlap
knuckle_z = leaf_thick / 2;                     // axis Z: centered on the leaf

// Countersunk mounting hole (axis Z), fixed dimensions.
hole_d = 4;      // straight bore diameter
cs_dia = 8;      // countersink diameter at the leaf's top face
cs_depth = 3;    // countersink cone depth -> straight wall = leaf_thick - cs_depth = 5mm
cs_x = -12;
cs_y = -leaf_width / 2;

// Hex boss (fixed $fn = 6), fixed dimensions.
hex_d = 8;
hex_h = 6;
hex_x = 0;
hex_y = -leaf_width / 2;

// Stadium slot (vertical, through the leaf), fixed dimensions.
slot_len = 12;   // end-to-end length
slot_w = 4;      // width (= end-cap diameter)
slot_x = 12;
slot_y = -leaf_width / 2;

// ---- Geometry ----

module leaf_slab() {
  translate([-leaf_len / 2, -leaf_width, 0])
    cube([leaf_len, leaf_width, leaf_thick]);
}

module knuckle_solid(x) {
  translate([x, knuckle_y, knuckle_z])
    rotate([0, 90, 0])
      cylinder(h = knuckle_len, r = knuckle_r, center = true);
}

module knuckle_bore() {
  // Runs the full leaf length plus overhang so every knuckle (and the gaps,
  // where it is a no-op — see header) gets a clean coaxial through-hole.
  translate([0, knuckle_y, knuckle_z])
    rotate([0, 90, 0])
      cylinder(h = leaf_len + 4, d = pin_d, center = true);
}

module hex_boss() {
  // Embedded 0.5mm into the slab so the union has a real overlap, not a
  // coincident face.
  translate([hex_x, hex_y, leaf_thick - 0.5])
    cylinder(h = hex_h + 0.5, d = hex_d, $fn = 6);
}

module countersink() {
  translate([cs_x, cs_y, 0]) {
    // Straight bore, 1mm past the bottom face for a clean through-cut.
    translate([0, 0, -1])
      cylinder(h = (leaf_thick - cs_depth) + 1, d = hole_d);
    // Countersink cone: bottom = hole_d at the top of the straight bore,
    // top = cs_dia exactly at the leaf's real top face (no overhang needed —
    // this face is the countersink's true visible opening).
    translate([0, 0, leaf_thick - cs_depth])
      cylinder(h = cs_depth, d1 = hole_d, d2 = cs_dia);
  }
}

module stadium_slot() {
  // hull() of two same-height, same-radius Z-axis cylinders: a C1-continuous
  // stadium wall (see header) that runs the full leaf thickness plus overhang.
  translate([slot_x, slot_y, 0])
    hull() {
      for (dx = [-1, 1])
        translate([dx * (slot_len - slot_w) / 2, 0, -1])
          cylinder(h = leaf_thick + 2, d = slot_w);
    }
}

module hinge() {
  difference() {
    union() {
      leaf_slab();
      for (x = knuckle_x) knuckle_solid(x);
      hex_boss();
    }
    knuckle_bore();
    countersink();
    stadium_slot();
  }
}

hinge();
