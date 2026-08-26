import { Hono } from "hono";
import { healthRoute } from "./routes/health.js";

// Exported separately from the entry point so tests can exercise the app
// without binding a real network port.
export function createApp() {
  const app = new Hono();
  app.route("/", healthRoute);
  return app;
}
