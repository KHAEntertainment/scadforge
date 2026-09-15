// SPDX-License-Identifier: Apache-2.0
//
// Fault-harness driver (Issue #99, S3-B ticket B8, Phase 1). Performs one
// ordinary params write against a temp project -- mirrors
// `apps/server/src/services/scad-core-impl.ts`'s real `updateParams`
// exactly: `mergeParamsAtomic` (reads current root params under the boundary,
// merges accepted values), then either `createSnapshotLocked` with the
// CURRENT source unchanged (the `snapshot !== false` path -- a params write
// is not a model edit) or `updateRootParamsLocked` for the snapshot:false
// path -- so the crash matrix exercises the real production writer shape,
// never an invented one. See `fault-harness.ts`'s module header for why this
// is plain JavaScript, spawned as a real child process.

import { readFile } from "node:fs/promises";
import { createSnapshotLocked, mergeParamsAtomic, rootModelPath, updateRootParamsLocked } from "@scadforge/scad-core";

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined) {
    console.error(`params-write driver: missing required env var '${name}'`);
    process.exit(1);
  }
  return value;
}

const projectDir = requireEnv("SCADFORGE_DRIVER_PROJECT_DIR");
const snapshot = process.env.SCADFORGE_DRIVER_SNAPSHOT !== "false";
const accepted = process.env.SCADFORGE_DRIVER_ACCEPTED_JSON ? JSON.parse(process.env.SCADFORGE_DRIVER_ACCEPTED_JSON) : {};
const message = process.env.SCADFORGE_DRIVER_MESSAGE ?? "fault-harness params write";

await mergeParamsAtomic(projectDir, accepted, async (merged, ctx) => {
  if (snapshot) {
    const content = await readFile(rootModelPath(ctx.projectDir), "utf8").catch(() => "");
    await createSnapshotLocked(ctx, { content, params: merged, message, origin: "manual", pass: null });
  } else {
    await updateRootParamsLocked(ctx, merged);
  }
});
