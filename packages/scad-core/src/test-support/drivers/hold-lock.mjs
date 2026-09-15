// SPDX-License-Identifier: Apache-2.0
//
// Fault-harness driver (Issue #99, S3-B ticket B8, Phase 1). Acquires the
// recovery boundary (the params lock, `withRecoveredProject`) against a temp
// project and holds it open indefinitely, printing `LOCK_HELD` to stdout
// once it is genuinely inside -- the harness either kills this process
// (proving a DEAD holder's lock IS reclaimed) or leaves it running as a
// second, genuinely live child (proving a LIVE holder's lock is NEVER
// reclaimed). See `fault-harness.ts`'s module header for why this is plain
// JavaScript, spawned as a real child process.

import { withRecoveredProject } from "@scadforge/scad-core";

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined) {
    console.error(`hold-lock driver: missing required env var '${name}'`);
    process.exit(1);
  }
  return value;
}

const projectDir = requireEnv("SCADFORGE_DRIVER_PROJECT_DIR");

await withRecoveredProject(projectDir, async () => {
  process.stdout.write("LOCK_HELD\n");
  // A bare `new Promise(() => {})` does NOT keep Node's event loop alive --
  // with no other pending timer/handle, Node treats the loop as idle at the
  // next `beforeExit` check and terminates the process anyway (silently
  // abandoning this still-suspended async function, `finally` blocks
  // included), which would make a genuinely LIVE holder indistinguishable
  // from one that crashed. A real, uncleaned interval is a real libuv handle
  // that keeps the loop -- and this process -- alive until the harness
  // SIGKILLs it.
  await new Promise(() => setInterval(() => {}, 60_000));
});
