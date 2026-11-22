// Test-only fixture for proof.docker.test.ts (Issue #91, S3-B ticket B5).
//
// Neither the repository's clamp (evals/scenario-a2/fixture/clamp.scad,
// `pipe_dia`) nor hinge (evals/surface-inspection/fixture/hinge.scad,
// `pin_d`) fixture has a Customizer parameter whose VALUE is a true
// radius — both control diameter directly. This minimal fixture exists
// solely to give the proof service's radius-meaning radial check
// real-engine evidence (not mock-only), per the Tech Lead's plan
// correction. Kept next to proof.docker.test.ts, not under the
// repository's user-facing eval fixtures or apps/server project data.
//
// SPDX-License-Identifier: Apache-2.0

/* [Boss] */
// Bore radius (mm)
bore_r = 3; // [1:0.5:8]

difference() {
  cube([20, 20, 10], center = true);
  cylinder(r = bore_r, h = 12, center = true, $fn = 96);
}
