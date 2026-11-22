// SPDX-License-Identifier: Apache-2.0
//
// Fault-harness driver (Issue #99, S3-B ticket B8, Phase 1). Reverts to a
// target snapshot against a temp project via the BUILT
// @scadforge/scad-core. See `fault-harness.ts`'s module header for why this
// is plain JavaScript, spawned as a real child process.

import { revertToSnapshot } from "@scadforge/scad-core";

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined) {
    console.error(`revert driver: missing required env var '${name}'`);
    process.exit(1);
  }
  return value;
}

const projectDir = requireEnv("SCADFORGE_DRIVER_PROJECT_DIR");
const targetId = requireEnv("SCADFORGE_DRIVER_TARGET_ID");

await revertToSnapshot(projectDir, targetId);
