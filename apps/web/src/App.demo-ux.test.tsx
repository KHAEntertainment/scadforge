// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for Issue #41 — the three defects from the first
// hands-on demo session, wired end to end through the real `App`.
//
// These drive the app the way the demo did: a project that ALREADY has
// snapshots on disk (i.e. what a page refresh sees), with no live chat turn
// having run in this session. That distinction is the whole bug — the old code
// sourced the preview from live chat state, so everything below rendered blank
// until a turn happened, and blank again after a refresh.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotManifest } from "@scadforge/protocol";
import { App } from "./App.js";

const PROJECT_ID = "untitled";

function jsonResponse(body: unknown, ok = true) {
  const raw = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(raw)
  } as Response);
}

const projectManifest = {
  schema_version: 1,
  id: PROJECT_ID,
  name: "untitled",
  created: "2026-08-28T00:00:00.000Z",
  updated: "2026-08-28T00:06:39.169Z",
  openscad_image: "openscad@sha256:abc",
  openscad_version: "2026.01.19",
  provider: { provider: "claude-agent-sdk", model: null, max_passes: 2 },
  head: "0002"
};

/** Mirrors the live-session manifest quoted in the issue. */
function snapshot(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    id: "0002",
    parent: "0001",
    timestamp: "2026-08-28T00:06:39.169Z",
    message: "Hinged 200x100x60 box",
    origin: "agent",
    pass: 1,
    files: {
      model_scad: "model.scad",
      params_json: "params.json",
      message_md: "message.md",
      validation_json: "validation.json",
      diff_patch: "diff.patch"
    },
    params: {},
    renders: [
      {
        view: "iso",
        file: "views/iso.png",
        url: `/api/projects/${PROJECT_ID}/snapshots/0002/views/iso`,
        width: 1024,
        height: 768,
        bytes: 52900,
        render_ms: 625
      },
      {
        view: "front",
        file: "views/front.png",
        url: `/api/projects/${PROJECT_ID}/snapshots/0002/views/front`,
        width: 1024,
        height: 768,
        bytes: 6912,
        render_ms: 556
      }
    ],
    // The live session's actual verdict: manifold, but five disconnected
    // pieces, amber badge, one warning — none of which reached the user.
    validation: { badge: "amber", manifold: true, components: 5, volume_mm3: 164079.57, warning_count: 1 },
    annotations: [],
    ...overrides
  };
}

interface MockOptions {
  snapshots?: SnapshotManifest[];
  /** Whether the mesh route reports a persisted mesh for a snapshot. */
  meshFor?: (snapshotId: string) => boolean;
  onChat?: (body: unknown) => void;
}

function installFetchMock(options: MockOptions = {}) {
  const snapshots = options.snapshots ?? [snapshot()];
  const hasMesh = options.meshFor ?? (() => true);

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/health")) {
      return jsonResponse({ ok: true, version: "0.0.0", openscad_image: "openscad@sha256:abc", openscad_version: "2026.01.19" });
    }
    if (url.endsWith("/api/projects") && method === "GET") {
      return jsonResponse({ projects: [projectManifest] });
    }
    const meshMatch = /\/snapshots\/([^/]+)\/mesh$/.exec(url);
    if (meshMatch) {
      const ok = hasMesh(meshMatch[1]);
      return Promise.resolve({ ok, status: ok ? 200 : 404, text: () => Promise.resolve(""), json: () => Promise.resolve({}) } as Response);
    }
    const diffMatch = /\/snapshots\/([^/]+)\/diff$/.exec(url);
    if (diffMatch) {
      const target = snapshots.find((s) => s.id === diffMatch[1]);
      return jsonResponse({ id: diffMatch[1], parent: target?.parent ?? null, diff: "" });
    }
    if (url.endsWith("/snapshots")) {
      return jsonResponse({ snapshots });
    }
    if (url.endsWith("/chat") && method === "POST") {
      options.onChat?.(init?.body);
      // A turn that never streams anything back: the user's own message must
      // still be on screen. Nothing here echoes it.
      return Promise.resolve({ ok: true, status: 200, body: null } as unknown as Response);
    }
    if (url.includes(`/api/projects/${PROJECT_ID}`)) {
      return jsonResponse({ project: projectManifest, scad: "cube(1);", params: {}, head: snapshots[0] ?? null });
    }
    return jsonResponse({ error_code: "NOT_FOUND", message: `unhandled: ${url}` }, false);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("Issue #41 symptom 1 — the 3D preview is blank", () => {
  it("previews the newest persisted snapshot's mesh with no chat turn in this session (i.e. after a refresh)", async () => {
    installFetchMock();
    render(<App />);

    // `viewer-3d` only renders once a non-null mesh URL reached Viewer3D, so
    // its presence is the assertion: the viewer is driven by persisted
    // snapshot state, not by live chat state.
    await waitFor(() => expect(screen.getByTestId("viewer-3d")).toBeInTheDocument());
  });

  it("counterexample: a snapshot with no persisted mesh explains itself instead of showing a bare/blank viewer", async () => {
    installFetchMock({ meshFor: () => false });
    render(<App />);

    // Waiting on the TEXT, not just the element: a placeholder is on screen
    // from the first paint, so asserting its presence alone would pass before
    // the snapshot list and mesh probe had resolved.
    await waitFor(() =>
      expect(screen.getByTestId("viewer-placeholder")).toHaveTextContent("has no 3D mesh yet")
    );
    // And specifically NOT the misleading first-run message.
    expect(screen.getByTestId("viewer-placeholder")).not.toHaveTextContent("Send a message");
    expect(screen.queryByTestId("viewer-3d")).not.toBeInTheDocument();
  });

  it("the PNG view buttons show the selected snapshot's persisted server renders", async () => {
    installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("viewer-3d")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("view-button-front"));

    const img = await screen.findByAltText("front view render");
    expect(img).toHaveAttribute("src", `/api/projects/${PROJECT_ID}/snapshots/0002/views/front`);
  });

  it("a view with no render for this snapshot says so rather than showing a broken image", async () => {
    installFetchMock();
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("viewer-3d")).toBeInTheDocument());
    // The fixture snapshot has iso + front only.
    fireEvent.click(screen.getByTestId("view-button-top"));
    expect(screen.getByTestId("png-placeholder")).toHaveTextContent("No top render yet");
  });

  it("selecting an older snapshot in History repoints the preview at THAT snapshot", async () => {
    const older = snapshot({
      id: "0001",
      parent: null,
      message: "Initial snapshot",
      origin: "initial",
      renders: [],
      validation: null
    });
    installFetchMock({
      snapshots: [snapshot(), older],
      // Only 0002 was ever validated, so only it has a mesh.
      meshFor: (id) => id === "0002"
    });
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("viewer-3d")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    const rows = await screen.findAllByTestId("snapshot-row");
    // Rows are newest-first, so [1] is 0001.
    fireEvent.click(rows[1]);

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("viewer-placeholder")).toBeInTheDocument());
    expect(screen.getByTestId("viewer-placeholder")).toHaveTextContent("Snapshot 0001");
    // The validation panel followed the selection too.
    expect(screen.getByTestId("validation-panel-badge")).toHaveTextContent("Not validated");
  });
});

describe("Issue #41 symptom 2 — the user's prompt never appears", () => {
  it("echoes the submitted message into the transcript immediately", async () => {
    installFetchMock();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("viewer-3d")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Make me a hinged box" } });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);

    // No waitFor: the echo must not depend on the request resolving.
    expect(screen.getByTestId("chat-user-message")).toHaveTextContent("Make me a hinged box");
  });

  it("the echo survives the turn failing, and appears exactly once", async () => {
    installFetchMock();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("viewer-3d")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Make me a hinged box" } });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);

    // The mocked chat response has no body, so the turn errors out.
    await waitFor(() => expect(screen.getByTestId("chat-stream-error")).toBeInTheDocument());
    expect(screen.getAllByTestId("chat-user-message")).toHaveLength(1);
    expect(screen.getByTestId("chat-user-message")).toHaveTextContent("Make me a hinged box");
  });

  it("survives a page refresh without duplicating (AC)", async () => {
    installFetchMock();
    const first = render(<App />);
    await waitFor(() => expect(screen.getByTestId("viewer-3d")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Make me a hinged box" } });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    await waitFor(() => expect(screen.getByTestId("chat-stream-error")).toBeInTheDocument());

    // Unmount + remount with storage intact is what a refresh is, from this
    // app's point of view.
    first.unmount();
    render(<App />);

    await waitFor(() => expect(screen.getAllByTestId("chat-user-message")).toHaveLength(1));
    expect(screen.getByTestId("chat-user-message")).toHaveTextContent("Make me a hinged box");
  });
});

describe("Issue #41 symptom 3 — validation warnings are invisible", () => {
  it("shows the badge and states that the model is 5 separate pieces", async () => {
    installFetchMock();
    render(<App />);

    // The panel renders "Not validated" before the snapshot list arrives, so
    // wait for the real verdict rather than for the element.
    await waitFor(() => expect(screen.getByTestId("validation-panel-badge")).toHaveTextContent("Warnings"));
    expect(screen.getByTestId("validation-findings")).toHaveTextContent("This model is 5 separate pieces");
    // The status strip badge is driven by the same snapshot.
    expect(screen.getByTestId("validation-badge")).toHaveTextContent("Warnings");
  });
});
