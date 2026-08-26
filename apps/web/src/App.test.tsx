import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body)
  } as Response);
}

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the shell and loads project/health/snapshot state without crashing", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return jsonResponse({ ok: true, version: "0.0.0", openscad_image: "openscad@sha256:abc", openscad_version: "2026.01.19" });
      }
      if (url.endsWith("/api/projects") && (!init || init.method === undefined)) {
        return jsonResponse({ projects: [] });
      }
      if (url.endsWith("/api/projects") && init?.method === "POST") {
        return jsonResponse({
          project: {
            schema_version: 1,
            id: "p1",
            name: "untitled",
            created: "2026-08-26T00:00:00.000Z",
            updated: "2026-08-26T00:00:00.000Z",
            openscad_image: "openscad@sha256:abc",
            openscad_version: "2026.01.19",
            provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
            head: null
          },
          scad: "",
          params: {},
          head: null
        });
      }
      if (url.includes("/snapshots")) {
        return jsonResponse({ snapshots: [] });
      }
      return jsonResponse({ error_code: "NOT_FOUND", message: "unhandled in test" }, false);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(screen.getByLabelText("Chat")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("openscad-version")).toHaveTextContent("2026.01.19"));
  });
});
