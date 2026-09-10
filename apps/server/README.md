# @scadforge/server

Hono server (SDP §11) on Node 22: REST + SSE API for the agent, the
filesystem project store, and the OpenSCAD render pipeline. No database,
no auth (PROJECT_CONTEXT.md).

- `src/routes/` — one route file per resource: health, projects, chat,
  snapshots, renders, params, and export are implemented.
- `src/services/` — business logic, kept out of the route layer.
- `GET /api/health` — liveness, application version, and pinned OpenSCAD availability.

See [the web development guide](../web/README.md#local-demo-boot-sequence)
for the API server and Vite proxy boot sequence. The entry point wires the
real filesystem/CAD services and agent provider; tests inject those services
through `createApp`.

Errors follow `{"error_code": "...", "message": "..."}`; external calls
(OpenSCAD subprocess, filesystem) are always wrapped with a timeout and a
typed error.

License: GPL-3.0-or-later (repo default — not in the GPL-free zone).
