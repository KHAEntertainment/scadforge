// Test-only fixture for proof.docker.test.ts (Issue #91, S3-B ticket B5).
//
// Real-engine evidence for the match-criteria ruling's "collinear
// same-diameter segments that all track the parameter count as ONE
// segmented feature and pass" (proof.ts's header comment). Three separate
// tube segments, coaxial on the X axis at FIXED positions (unlike
// evals/surface-inspection/fixture/hinge.scad's knuckles, whose Y/Z
// position is itself derived from `pin_d` — see that file's own docker
// tests) — here only the bore diameter depends on the Customizer
// parameter, so a diameter-meaning radial binding genuinely passes with
// `regions: 3` across every sample.
//
// SPDX-License-Identifier: Apache-2.0

/* [Bores] */
// Coaxial bore diameter, through all three segments (mm)
bore_d = 4; // [2:0.5:8]

// ---- Helpers (fixed constants; do not vary with bore_d) ----

segment_positions = [-20, 0, 20];
segment_len = 10;
segment_od = 12; // fixed outer diameter, comfortably above bore_d's legal max (8)

module segment(x) {
  translate([x, 0, 0])
    rotate([0, 90, 0])
      cylinder(d = segment_od, h = segment_len, center = true, $fn = 48);
}

module bore() {
  // Runs the full span (segments plus gaps) as one coaxial cut; a no-op
  // where there is no segment material.
  rotate([0, 90, 0])
    cylinder(d = bore_d, h = 200, center = true, $fn = 48);
}

difference() {
  union()
    for (x = segment_positions) segment(x);
  bore();
}
