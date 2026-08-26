import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { notWiredAgentProvider, notWiredScadCoreApi } from "./services/not-wired.js";

const port = Number(process.env.PORT ?? 3001);

// Placeholder deps until Issue #20 wires the real scad-core (#14) / agent
// (#16) implementations in — see services/not-wired.ts.
const app = createApp({ scadCore: notWiredScadCoreApi, agent: notWiredAgentProvider });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScadForge server listening on http://localhost:${info.port}`);
});
