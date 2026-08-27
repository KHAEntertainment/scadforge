// SPDX-License-Identifier: Apache-2.0
//
// Entry point. The ONLY place the real implementations are constructed —
// `createApp({scadCore, agent})` stays the single dependency-injection point,
// so tests and the Scenario A eval harness can substitute either seam without
// touching a route file.

import { mkdir } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createRealAgentProvider } from "./services/agent-impl.js";
import { createScadCoreApi } from "./services/scad-core-impl.js";
import { createServerRuntime } from "./services/runtime.js";

const port = Number(process.env.PORT ?? 3001);

const runtime = createServerRuntime();
await mkdir(runtime.root, { recursive: true });

const app = createApp({
  scadCore: createScadCoreApi(runtime),
  agent: createRealAgentProvider({ runtime })
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScadForge server listening on http://localhost:${info.port}`);
  console.log(`  projects root: ${runtime.root}`);
  console.log(`  provider:      ${runtime.provider.provider} (model: ${runtime.provider.model ?? "sdk default"})`);
  console.log(`  max passes:    ${runtime.provider.max_passes}`);
});
