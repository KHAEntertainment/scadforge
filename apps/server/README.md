# @scadforge/server

Hono server (SDP §11) on Node 22: REST + SSE API for the agent, the
filesystem project store, and the OpenSCAD render pipeline. No database,
no auth (PROJECT_CONTEXT.md).

- `src/routes/` — one route file per resource (CLAUDE.md hard rule 3):
  `health.ts` today; `projects.ts, chat.ts, snapshots.ts, renders.ts,
  params.ts, export.ts` land with their respective feature issues.
- `src/services/` — business logic, kept out of the route layer.
- `GET /health` → `{"status":"ok"}` — liveness probe, implemented here.

Errors follow `{"error_code": "...", "message": "..."}`; external calls
(OpenSCAD subprocess, filesystem) are always wrapped with a timeout and a
typed error.

License: GPL-3.0-or-later (repo default — not in the GPL-free zone).
