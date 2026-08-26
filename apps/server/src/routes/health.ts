import { Hono } from "hono";

// One route file per resource (CLAUDE.md hard rule 3): health-check only.
export const healthRoute = new Hono().get("/health", (c) => {
  return c.json({ status: "ok" });
});
