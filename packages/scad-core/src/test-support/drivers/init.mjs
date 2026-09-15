// SPDX-License-Identifier: Apache-2.0
//
// Fault-harness driver (Issue #99, S3-B ticket B8, Phase 1). Initializes a
// temp project via the BUILT @scadforge/scad-core -- `fault-harness.ts`'s
// module header explains why this is plain JavaScript, spawned as a real
// child process, rather than TypeScript run in-process. Honors
// SCADFORGE_FAULT_POINT exactly like any real caller: this file never reads
// or arms it itself -- `transaction.ts`'s own `faultPoint()` already checks
// `process.env.SCADFORGE_FAULT_POINT` internally, so setting it only on this
// process's spawned environment (`fault-harness.ts`'s `driverEnv`) is
// sufficient to fire a real SIGKILL partway through `initProject`.

import { initProject } from "@scadforge/scad-core";

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined) {
    console.error(`init driver: missing required env var '${name}'`);
    process.exit(1);
  }
  return value;
}

const projectDir = requireEnv("SCADFORGE_DRIVER_PROJECT_DIR");
const id = requireEnv("SCADFORGE_DRIVER_PROJECT_ID");
const content = Buffer.from(requireEnv("SCADFORGE_DRIVER_CONTENT_B64"), "base64").toString("utf8");
const params = process.env.SCADFORGE_DRIVER_PARAMS_JSON ? JSON.parse(process.env.SCADFORGE_DRIVER_PARAMS_JSON) : {};

await initProject(projectDir, {
  id,
  name: id,
  provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
  content,
  params
});
