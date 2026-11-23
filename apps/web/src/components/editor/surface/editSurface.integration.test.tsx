// SPDX-License-Identifier: Apache-2.0
//
// S3-C C4 — UI-level integration tests (Issue #136 criterion 7, the comment
// items and the Tech-Lead conditions). These render the real `<App />` (the
// real Workspace tab, hooks, `useEditorSession`, controller,
// `createEditorClient`, `useEditorDocument` and `createApiClient`) against
// `fakeEditorServer.ts`, an in-memory server double whose command
// application, traversal checks and revisions come from `@scadforge/scad-core`
// and whose editor request parsing comes from `@scadforge/protocol`. They are
// NOT production-store tests (no filesystem store, no `apps/server`, no
// OpenSCAD): that suite is C5's. The preview engine is a controllable fake
// standing in for `useWasmPreview`. No Docker.

import { StrictMode, useEffect, useReducer, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamValues } from "@scadforge/protocol";
import { App } from "../../../App.js";
import { createApiClient, type ApiClient } from "../../../lib/apiClient.js";
import { EditSurface } from "./EditSurface.js";
import { FakeEditorServer } from "./fakeEditorServer.js";
import { useEditorSession, type EditorSession } from "./useEditorSession.js";

// ── the fake preview engine ───────────────────────────────────────────────

type EngineResult = { status: "idle" | "pending" | "ok" | "error" | "timeout" | "fatal"; objectUrl: string | null; stderr: null; lastRenderMs: null; coldInit: null };

class FakeEngine {
  /** `auto` answers each request on the next tick; `manual` waits for `finish()`. */
  mode: "auto" | "manual" = "auto";
  /** Auto mode fails while this is true. */
  failing = false;
  readonly requests: ParamValues[] = [];
  result: EngineResult = { status: "idle", objectUrl: null, stderr: null, lastRenderMs: null, coldInit: null };
  readonly listeners = new Set<() => void>();
  private counter = 0;

  emit(status: EngineResult["status"], objectUrl: string | null): void {
    this.result = { status, objectUrl, stderr: null, lastRenderMs: null, coldInit: null };
    for (const listener of this.listeners) listener();
  }

  request(params: ParamValues): void {
    this.requests.push(params);
    this.emit("pending", this.result.objectUrl);
    if (this.mode === "auto") setTimeout(() => this.finish(!this.failing), 0);
  }

  finish(ok: boolean): void {
    if (ok) {
      this.counter += 1;
      this.emit("ok", `blob:fake-mesh-${this.counter}`);
    } else {
      this.emit("error", this.result.objectUrl);
    }
  }
}

const holder = vi.hoisted(() => ({ hook: null as null | ((scad: string | null, params: ParamValues, enabled: boolean) => unknown) }));
vi.mock("../../../wasm/index.js", () => ({
  useWasmPreview: (scad: string | null, params: ParamValues, enabled: boolean) => holder.hook!(scad, params, enabled)
}));

// The Code tab's Monaco editor, as a plain textarea (jsdom cannot run Monaco).
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value: string; onChange?: (next: string | undefined) => void }) => (
    <textarea aria-label="OpenSCAD source" value={value} onChange={(event) => onChange?.(event.target.value)} />
  )
}));

let engine = new FakeEngine();
const IDLE_RESULT: EngineResult = { status: "idle", objectUrl: null, stderr: null, lastRenderMs: null, coldInit: null };

function useFakeEngine(scad: string | null, params: ParamValues, enabled: boolean): EngineResult {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const current = engine;
    current.listeners.add(force);
    return () => {
      current.listeners.delete(force);
    };
  }, []);
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!enabled || scad === null) return;
    engine.request(JSON.parse(key) as ParamValues);
  }, [enabled, scad, key]);
  return enabled ? engine.result : IDLE_RESULT;
}
holder.hook = useFakeEngine;

// ── fixtures ──────────────────────────────────────────────────────────────

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WALL_FEATURE = {
  featureId: "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  label: "Wall",
  binding: { kind: "linear" as const, parameter: "wall", axis: "x" as const, mapping: { scale: 1 as const, offset: 0, anchor: "min" as const } }
};

let server: FakeEditorServer;

function seedServer(...ids: string[]): FakeEditorServer {
  return new FakeEditorServer((ids.length ? ids : ["p1"]).map((id) => ({ id, values: { wall: 2 }, features: [WALL_FEATURE] })));
}

beforeEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* storage optional */
  }
  engine = new FakeEngine();
  server = seedServer();
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function status(): HTMLElement {
  return screen.getByTestId("edit-status");
}

async function openEdit(): Promise<void> {
  fireEvent.click(await screen.findByRole("tab", { name: "Edit" }));
  await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
}

function wallInput(): HTMLInputElement {
  return screen.getByLabelText(/^Wall/) as HTMLInputElement;
}

function typeWall(value: string): void {
  fireEvent.change(wallInput(), { target: { value } });
}

function clickButton(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

async function saveWall(value: string): Promise<void> {
  typeWall(value);
  clickButton("Save");
  // Exactly "Saved." — the idle notice, not "Saved. Updating the preview…" (still committing).
  await waitFor(() => expect(status().textContent).toBe("Saved."), { timeout: 3000 });
}

function editorGets(): number {
  return server.log.filter((line) => line === "GET /projects/p1/editor").length;
}

describe("Edit surface — integration through the UI (in-memory server double)", () => {
  it("integration_normal_gesture_one_snapshot_one_revision_delta", async () => {
    render(<App />);
    await openEdit();
    const before = { revision: server.editorRevision("p1"), snapshots: server.projects.get("p1")!.snapshots.length };

    await saveWall("3");

    expect(server.acceptedCommits).toBe(1);
    expect(server.commitPosts).toHaveLength(1);
    expect(server.commitPosts[0].operationId).toMatch(UUID_V4);
    expect(server.projects.get("p1")!.snapshots.length).toBe(before.snapshots + 1);
    expect(server.editorRevision("p1")).not.toBe(before.revision);
    expect(server.values("p1")).toEqual({ wall: 3 });
    await waitFor(() => expect(wallInput().value).toBe("3"));
  });

  it("integration_typed_gesture_finalizes_after_port_state_updates", async () => {
    render(<App />);
    await openEdit();
    engine.mode = "manual";
    typeWall("4");
    clickButton("Save");
    // Save is waiting on the port. The engine reports `ok` BEFORE the new
    // geometry exists (Failure B's ordering): nothing may be committed yet.
    await waitFor(() => expect(engine.requests.at(-1)).toEqual({ wall: 4 }));
    act(() => engine.emit("ok", engine.result.objectUrl));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.commitPosts).toHaveLength(0);
    expect(status()).toHaveTextContent("Rendering the preview…");

    // The geometry arrives: the commit goes out with no further user action.
    act(() => engine.finish(true));
    await waitFor(() => expect(status()).toHaveTextContent("Saved."), { timeout: 3000 });
    expect(server.acceptedCommits).toBe(1);
    expect(server.values("p1")).toEqual({ wall: 4 });
  });

  it("integration_drag_release_with_pending_preview_recovers_on_cancel", async () => {
    const api = createApiClient({ fetchImpl: server.fetch });
    render(<DragHarness api={api} projectId="p1" />);
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    engine.mode = "manual";
    const handle = screen.getByTestId("drag-handle");

    // Drag starts (capture + candidate), then releases while the preview is pending.
    fireEvent.pointerDown(handle, { pointerId: 7 });
    await waitFor(() => expect(engine.requests.at(-1)).toEqual({ wall: 5 }));
    fireEvent.pointerUp(handle, { pointerId: 7 });
    // The render fails after the release: finalize settles as preview-failed (never strands).
    await waitFor(() => expect(screen.getByTestId("drag-result")).toHaveTextContent("waiting"));
    act(() => engine.finish(false));
    await waitFor(() => expect(screen.getByTestId("drag-result")).toHaveTextContent("preview-failed"));
    expect(status()).toHaveTextContent("The preview failed.");

    // The browser's implicit release after pointerup fires lostpointercapture → cancel → idle.
    engine.mode = "auto";
    act(() => {
      handle.dispatchEvent(new Event("lostpointercapture"));
    });
    await waitFor(() => expect(status()).toHaveTextContent("Ready."));
    expect(server.commitPosts).toHaveLength(0);

    // A fresh drag begins and commits normally.
    fireEvent.pointerDown(handle, { pointerId: 8 });
    fireEvent.pointerUp(handle, { pointerId: 8 });
    await waitFor(() => expect(screen.getByTestId("drag-result")).toHaveTextContent("committed"), { timeout: 3000 });
    expect(server.acceptedCommits).toBe(1);
  });

  it("integration_blocked_entry_while_params_pending_resolves_after_params_settled", async () => {
    const hold = server.hold("params-update");
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Params" }));
    const slider = await screen.findByLabelText("wall");
    fireEvent.change(slider, { target: { value: "6" } });
    await hold.arrived;

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Editing is off until your parameter changes finish saving."), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    hold.release();
    // The save is an external write: re-read, then editing resumes on the new value.
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    expect(wallInput().value).toBe("6");
    await saveWall("7");
    expect(server.values("p1")).toEqual({ wall: 7 });
  });

  it("integration_preview_failure_after_accepted_save_disables_next_gesture_until_display_recovers", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");

    // The undo is accepted, but displaying its result fails.
    engine.failing = true;
    clickButton("Undo");
    await waitFor(() => expect(status()).toHaveTextContent("Your change was saved, but the preview could not be updated."), { timeout: 3000 });
    expect(server.values("p1")).toEqual({ wall: 2 });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    typeWall("9");
    clickButton("Save");
    expect(server.commitPosts).toHaveLength(2);

    engine.failing = false;
    clickButton("Retry preview");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(), { timeout: 3000 });
    expect(status()).not.toHaveTextContent("could not be updated");
    expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
  });

  it("integration_superseded_receipt_recovers_without_waiting_for_old_revision", async () => {
    render(<App />);
    await openEdit();
    // Another tab writes R2 right after our R1 lands, before our re-read.
    server.afterCommit = (projectId) => {
      server.afterCommit = null;
      server.externalWrite(projectId, { wall: 8 });
    };
    const getsBefore = editorGets();

    typeWall("3");
    clickButton("Save");
    await waitFor(() => expect(status()).toHaveTextContent("Saved."), { timeout: 3000 });
    await waitFor(() => expect(wallInput().value).toBe("8"));

    // One re-read, no wait for R1, and the log is stale (R2 is not ours).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(editorGets() - getsBefore).toBe(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("integration_dropped_chat_stream_keeps_edit_disabled_until_reconciled", async () => {
    render(<App />);
    await openEdit();
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "make it thicker" } });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    await waitFor(() => expect(server.log).toContain("POST /projects/p1/chat"));

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Editing is off while this tab's chat turn is running or its result is unknown."));

    // The stream drops: `isStreaming` goes false, but the outcome is unknown.
    act(() => server.dropChat());
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    await screen.findByRole("button", { name: "Check result" });
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(status()).toHaveTextContent("Editing is off while this tab's chat turn is running or its result is unknown.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // The agent did write; reconciliation reports it and editing resumes on the new value.
    server.externalWrite("p1", { wall: 5 });
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    fireEvent.click(screen.getByRole("button", { name: "Check result" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check result" })).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    expect(wallInput().value).toBe("5");
  });
});

describe("Edit surface — carried-forward acceptance (Issue #136 comments, Tech-Lead conditions)", () => {
  it("after an accepted edit and its own re-read, undo stays available, and undo/redo both commit", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());

    clickButton("Undo");
    await waitFor(() => expect(status()).toHaveTextContent("Undo saved."), { timeout: 3000 });
    expect(server.values("p1")).toEqual({ wall: 2 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled());

    // Redo by shortcut goes through the same path as the button.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(status()).toHaveTextContent("Redo saved."), { timeout: 3000 });
    expect(server.values("p1")).toEqual({ wall: 3 });
  });

  it("an undo shortcut typed inside a text field is left to the field", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());
    fireEvent.keyDown(wallInput(), { key: "z", ctrlKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.commitPosts).toHaveLength(1);
  });

  it("a refused undo leaves the surface usable and shows no committed status", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());

    // While the undo is being verified, another tab announces a commit: an
    // external write for this tab. The server itself is unchanged, so the
    // proof is valid, but the controller refuses the traversal and sends nothing.
    const verifyHold = server.hold("verify");
    const rereadHold = server.hold("editor-get");
    clickButton("Undo");
    await verifyHold.arrived;
    const peer = new BroadcastChannel("scadforge-editor-p1");
    peer.postMessage({ type: "committed", operationId: "peer-operation" });
    peer.close();
    await rereadHold.arrived;
    verifyHold.release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(server.commitPosts).toHaveLength(1);

    rereadHold.release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(), { timeout: 3000 });
    expect(status()).toHaveTextContent("Nothing was sent");
    expect(status()).not.toHaveTextContent("Saved");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("dismissing a connection_lost item re-reads and re-enables editing (outcome unknown)", async () => {
    render(<App />);
    await openEdit();
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    await waitFor(() => expect(server.log).toContain("POST /projects/p1/chat"));
    act(() => server.dropChat());
    await screen.findByRole("button", { name: "Dismiss" });
    const getsBefore = editorGets();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    expect(editorGets()).toBeGreaterThan(getsBefore);
  });

  it("Escape, window blur and leaving the Edit tab each cancel a previewed gesture and send nothing", async () => {
    render(<App />);
    await openEdit();
    const sources: Array<() => void> = [
      () => fireEvent.keyDown(window, { key: "Escape" }),
      () => fireEvent.blur(window),
      () => fireEvent.click(screen.getByRole("tab", { name: /chat/i }))
    ];
    for (const cancel of sources) {
      typeWall("4");
      clickButton("Preview");
      await waitFor(() => expect(status()).toHaveTextContent("Preview ready."), { timeout: 3000 });
      act(cancel);
      if (!screen.queryByTestId("edit-status")) fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    }
    expect(server.commitPosts).toHaveLength(0);
    expect(server.values("p1")).toEqual({ wall: 2 });
  });

  it("a requires-proof feature is verified before the gesture begins, and that proof is reused for the save", async () => {
    server = new FakeEditorServer([
      { id: "p1", values: { wall: 2 }, features: [WALL_FEATURE], eligibility: [{ featureId: WALL_FEATURE.featureId, state: "requires-proof", reason: "changed" }] }
    ]);
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await openEdit();
    await saveWall("3");
    expect(server.acceptedCommits).toBe(1);
    expect(server.values("p1")).toEqual({ wall: 3 });
    expect(server.log.filter((line) => line === "POST /projects/p1/editor/verify")).toHaveLength(1);
  });

  it("a project switch during an ambiguous commit reconciles on return through the same page adapter", async () => {
    server = seedServer("p1", "p2");
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await openEdit();

    // The POST is lost before the server commits: the attempt is ambiguous.
    server.commitFaults.push("lost-before");
    typeWall("3");
    clickButton("Save");
    await waitFor(() => expect(status()).toHaveTextContent("Resolving"), { timeout: 3000 });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } });
    await waitFor(() => expect(server.log).toContain("GET /projects/p2/editor"), { timeout: 3000 });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p1" } });

    // Return: the lookup answers `unclaimed`; only the page adapter that sent
    // the original request knows it is unresolved, and re-sends it verbatim.
    await waitFor(() => expect(server.acceptedCommits).toBe(1), { timeout: 5000 });
    const sends = server.commitPosts.filter((post) => post.projectId === "p1");
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sends.map((post) => post.operationId)).size).toBe(1);
    expect(server.values("p1")).toEqual({ wall: 3 });
    await waitFor(() => expect(wallInput().value).toBe("3"), { timeout: 3000 });
  });

  it("leaving the Edit tab while committing still finishes the post-receipt step", async () => {
    render(<App />);
    await openEdit();
    const hold = server.hold("commit");
    typeWall("3");
    clickButton("Save");
    await hold.arrived;
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    hold.release();
    await waitFor(() => expect(server.acceptedCommits).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(wallInput().value).toBe("3");
  });

  it("an export keeps undo available; a revert clears it", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:download", revokeObjectURL: () => {} }));
    render(<App />);
    await openEdit();
    await saveWall("3");
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());

    fireEvent.click(screen.getByRole("tab", { name: /history/i }));
    fireEvent.click(within(await screen.findByTestId("export-button")).getAllByRole("button")[0]);
    await waitFor(() => expect(server.log).toContain("POST /projects/p1/export"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Ready."));
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    fireEvent.click(screen.getByRole("tab", { name: /history/i }));
    await screen.findAllByTestId("snapshot-row");
    fireEvent.click(screen.getAllByTestId("snapshot-row").at(-1)!);
    fireEvent.click(await screen.findByTestId("revert-trigger"));
    fireEvent.click(await screen.findByTestId("revert-confirm-yes"));
    await waitFor(() => expect(server.log.some((line) => line.endsWith("/revert"))).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("the edit preview shows only for the current project/snapshot and falls back to the server render when it fails", async () => {
    render(<App />);
    await openEdit();
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("Local edit preview — not built or validated."));
    expect(screen.getByTestId("viewer-3d")).toBeInTheDocument();
    expect(screen.getByTestId("measure-toggle")).toBeDisabled();

    // Render failure: the viewer falls back to the server render (none here → placeholder).
    engine.failing = true;
    typeWall("4");
    clickButton("Preview");
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("failed — showing the last server render"));
    expect(screen.queryByTestId("viewer-3d")).toBeNull();
    clickButton("Cancel");
    engine.failing = false;

    // A commit is mid-flight (the session keeps rendering with the tab closed)
    // and the user selects an older snapshot: no edit preview for it.
    const hold = server.hold("editor-get");
    await saveWallWithoutWaiting("3");
    await hold.arrived;
    fireEvent.click(screen.getByRole("tab", { name: /history/i }));
    await screen.findAllByTestId("snapshot-row");
    fireEvent.click(screen.getAllByTestId("snapshot-row").at(-1)!);
    await screen.findByText(/Viewing historical snapshot/);
    expect(screen.queryByTestId("edit-preview-status")).toBeNull();
    hold.release();
  });

  it("under StrictMode, loading and unsettled both read as not ready", async () => {
    const hold = server.hold("editor-get");
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).not.toHaveTextContent("Preparing the editor"));
    expect(status()).not.toHaveTextContent("Ready.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    hold.release();
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });

    // A later outstanding read (unsettled) disables entry again.
    const reread = server.hold("editor-get");
    fireEvent.click(screen.getByRole("tab", { name: "Params" }));
    fireEvent.change(await screen.findByLabelText("wall"), { target: { value: "3" } });
    await reread.arrived;
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(status()).not.toHaveTextContent("Ready.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    reread.release();
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
  });
});

describe("Edit surface — PR #140 fix batch 1", () => {
  it("F2: a late verify conflict from the previous project does nothing to the current project's session", async () => {
    server = seedServer("p1", "p2");
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await openEdit();
    const lateVerify = server.hold("verify");
    typeWall("3");
    clickButton("Save");
    await lateVerify.arrived;

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } });
    await waitFor(() => expect(server.log).toContain("GET /projects/p2/editor"), { timeout: 3000 });
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    await saveWall("4");
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());
    typeWall("5");
    clickButton("Preview");
    await waitFor(() => expect(status()).toHaveTextContent("Preview ready."), { timeout: 3000 });
    const p2Reads = server.log.filter((line) => line === "GET /projects/p2/editor").length;

    // p1 changes under its held check, so the check answers 409 CONFLICT, for p1.
    server.externalWrite("p1", { wall: 9 });
    lateVerify.release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(status()).toHaveTextContent("Preview ready.");
    expect(status()).not.toHaveTextContent("The project changed");
    expect(server.log.filter((line) => line === "GET /projects/p2/editor")).toHaveLength(p2Reads);
    clickButton("Cancel");
    await waitFor(() => expect(status()).toHaveTextContent("Ready."));
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(server.commitPosts.filter((post) => post.projectId === "p1")).toHaveLength(0);
  });

  it("F5: a fast chat turn whose terminal item is the only one ever rendered still re-reads the editor", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());
    const getsBefore = editorGets();

    // The agent writes wall = 6; start, write and done arrive in one chunk.
    server.fastChat = { values: { wall: 6 } };
    fireEvent.click(screen.getByRole("tab", { name: /chat/i }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "make it thicker" } });
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    await waitFor(() => expect(server.log).toContain("POST /projects/p1/chat"));

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(wallInput().value).toBe("6"), { timeout: 3000 });
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    expect(editorGets()).toBeGreaterThan(getsBefore);
    // The revision changed under the log: nothing of ours is left to undo.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("F3: after switching to a project with identical source and values, a save there completes", async () => {
    server = seedServer("p1", "p2");
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await openEdit();
    await waitFor(() => expect(engine.result.status).toBe("ok"), { timeout: 3000 });
    const requestsBefore = engine.requests.length;

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } });
    await waitFor(() => expect(server.log).toContain("GET /projects/p2/editor"), { timeout: 3000 });
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    // p2's display render is p1's geometry: nothing new was asked of the engine.
    expect(engine.requests.length).toBe(requestsBefore);

    await saveWall("4");
    expect(server.values("p2")).toEqual({ wall: 4 });
    expect(server.values("p1")).toEqual({ wall: 2 });
  });

  it("F1: after an editor save, Build waits for the source re-read, then sends the post-commit source revision", async () => {
    render(<App />);
    await openEdit();
    const reread = server.hold("source-get");
    await saveWall("3");
    await reread.arrived;
    const header = screen.getByRole("banner");
    const build = within(header).getByRole("button", { name: /^Build$/ });

    // Pressed before the clean source editor has the post-commit revision: nothing is sent.
    fireEvent.click(build);
    await screen.findByText("Loading the latest source before building…");
    expect(server.buildPosts).toHaveLength(0);

    reread.release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    fireEvent.click(build);
    await waitFor(() => expect(server.buildPosts).toHaveLength(1), { timeout: 3000 });
    expect(server.buildPosts[0].current).toBe(true);
    await screen.findByText(/Build complete/);
  });

  it("F1: a dirty source draft typed while an editor commit is in flight survives the commit", async () => {
    render(<App />);
    await openEdit();
    const hold = server.hold("commit");
    typeWall("3");
    clickButton("Save");
    await hold.arrived;

    fireEvent.click(screen.getByRole("tab", { name: /code/i }));
    await screen.findByLabelText("OpenSCAD source");
    // The lazy editor replaces its Suspense fallback; type into the one that stays.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const source = screen.getByLabelText("OpenSCAD source") as HTMLTextAreaElement;
    const draft = "cube([wall, 12, 10]); // my draft";
    fireEvent.change(source, { target: { value: draft } });
    expect((screen.getByLabelText("OpenSCAD source") as HTMLTextAreaElement).value).toBe(draft);
    const sourceReads = server.log.filter((line) => line === "GET /projects/p1/source").length;

    hold.release();
    await waitFor(() => expect(server.acceptedCommits).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect((screen.getByLabelText("OpenSCAD source") as HTMLTextAreaElement).value).toBe(draft);
    expect(server.log.filter((line) => line === "GET /projects/p1/source")).toHaveLength(sourceReads);
  });
});

async function saveWallWithoutWaiting(value: string): Promise<void> {
  typeWall(value);
  clickButton("Save");
  await waitFor(() => expect(server.acceptedCommits).toBeGreaterThan(0), { timeout: 3000 });
}

// ── Failure A harness: a synthetic drag owner on the adapter's capture hooks ──

function DragHarness({ api, projectId }: { api: ApiClient; projectId: string }) {
  const session = useEditorSession({
    api,
    projectId,
    sourceDirty: false,
    sourceConflict: false,
    paramsDirty: false,
    paramsSaving: false,
    chatItems: [],
    chatStreaming: false
  });
  return (
    <>
      <EditSurface session={session} />
      <DragSource session={session} />
    </>
  );
}

/** What S4-B's handle will do, minus pointer math: capture on down, finalize on up. */
function DragSource({ session }: { session: EditorSession }) {
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState("none");
  const sessionRef = useRef(session);
  sessionRef.current = session;

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const { controller, document } = sessionRef.current;
    if (!controller || !document) return;
    const began = controller.begin({
      featureId: WALL_FEATURE.featureId,
      bindingVersion: 1,
      baseEditorRevision: document.editorRevision,
      sourceFingerprint: document.sourceFingerprint,
      sidecarStatus: document.sidecarStatus,
      eligibility: null,
      freshProof: null,
      baseValue: document.values.wall as number
    });
    if (!began.ok) {
      setResult(`begin-refused:${began.reason}`);
      return;
    }
    sessionRef.current.adapter.capturePointer(ref.current!, event.pointerId);
    controller.propose(5, "drag");
  }

  async function onPointerUp() {
    const { controller, document, api, projectId } = sessionRef.current;
    if (!controller || !document || !projectId) return;
    const proof = await api.verifyEditorCommand(projectId, {
      version: 1,
      baseEditorRevision: document.editorRevision,
      command: { kind: "set-value", featureId: WALL_FEATURE.featureId, bindingVersion: 1, value: 5 },
      intent: "edit",
      traversal: null
    });
    setResult("waiting");
    const outcome = await controller.finalize(proof);
    setResult(outcome.kind);
  }

  return (
    <div ref={ref} data-testid="drag-handle" onPointerDown={onPointerDown} onPointerUp={() => void onPointerUp()}>
      <output data-testid="drag-result">{result}</output>
    </div>
  );
}
