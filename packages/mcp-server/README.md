# @scadforge/mcp-server

Placeholder for the M4 stdio MCP server binary (SDP §11). The current entry
point exports only the package name; it does not serve MCP requests yet.
The planned binary will expose the shared ScadForge agent
tools (`read_project, write_scad, set_params, render_views, validate_mesh,
export, library_lookup`) to MCP-compatible clients, reusing the same tool
contracts defined in `@scadforge/agent`.

License: Apache-2.0 (GPL-free zone — see PROJECT_CONTEXT.md license boundary).
