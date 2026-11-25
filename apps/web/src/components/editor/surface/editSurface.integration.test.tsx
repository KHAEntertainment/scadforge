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

// The 3D viewer records the URL it is given (jsdom has no WebGL; PreviewTab's own tests stub it the same way).
const viewer = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock("../../Viewer3D.js", () => ({
  Viewer3D: ({ stlUrl, emptyMessage }: { stlUrl: string | null; emptyMessage?: string }) => {
    if (stlUrl) viewer.log.push(stlUrl);
    return stlUrl ? <div data-testid="viewer-3d" data-url={stlUrl} /> : <div data-testid="viewer-placeholder">{emptyMessage}</div>;
  }
}));

// A pass-through around the real `useSnapshotMesh`. React flushes a discrete
// click (a project switch, "Return to current") in a microtask, before any
// network result, so jsdom cannot land a mesh result in the same render as the
// click; F4's tests inject that render's inputs here instead.
type MeshResult = { url: string | null; status: "idle" | "checking" | "ready" | "absent"; projectId?: string | null; snapshotId?: string | null };
const meshOverride = vi.hoisted(() => ({ fn: null as null | ((real: MeshResult, projectId: string | null, snapshotId: string | null) => MeshResult) }));
vi.mock("../../../hooks/useSnapshotMesh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../hooks/useSnapshotMesh.js")>();
  return {
    ...actual,
    useSnapshotMesh: (client: Parameters<typeof actual.useSnapshotMesh>[0], projectId: string | null, snapshotId: string | null) => {
      const real = actual.useSnapshotMesh(client, projectId, snapshotId);
      return meshOverride.fn ? meshOverride.fn(real, projectId, snapshotId) : real;
    }
  };
});

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
  viewer.log.length = 0;
  meshOverride.fn = null;
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

/** The URL the 3D viewer was handed, or `null` when it shows its empty placeholder. */
function viewerUrl(): string | null {
  return screen.queryByTestId("viewer-3d")?.getAttribute("data-url") ?? null;
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
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("The local edit preview failed. There is no server render of this project to show"));
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

    // Pressed before the clean source editor has the post-commit revision: nothing is sent (the press restarts the re-read).
    fireEvent.click(build);
    await screen.findByText("Still loading the latest source; trying again. Press Build once it has loaded.");
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

  it("G1 + F4: on a built head the server mesh keeps the viewer until a preview; while it renders the server mesh shows; Cancel gives it back", async () => {
    const headMesh = server.buildMesh("p1");
    render(<App />);
    await openEdit();
    // Before any edit: the validated server mesh, with Inspect and Measure.
    await waitFor(() => expect(viewerUrl()).toBe(headMesh), { timeout: 3000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(viewerUrl()).toBe(headMesh);
    expect(screen.queryByTestId("edit-preview-status")).toBeNull();
    expect(screen.getByTestId("inspect-toggle")).toBeEnabled();
    expect(screen.getByTestId("measure-toggle")).toBeEnabled();

    // During a preview: the server mesh (labelled as predating the edit) until the local render exists.
    engine.mode = "manual";
    typeWall("4");
    clickButton("Preview");
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("showing the last server render, from before this edit."));
    expect(viewerUrl()).toBe(headMesh);
    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();
    act(() => engine.finish(true));
    await waitFor(() => expect(viewerUrl()).toMatch(/^blob:fake-mesh-/));
    expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("Local edit preview — not built or validated.");
    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();

    // Cancel: the server mesh again.
    engine.mode = "auto";
    clickButton("Cancel");
    await waitFor(() => expect(viewerUrl()).toBe(headMesh));
    expect(screen.queryByTestId("edit-preview-status")).toBeNull();
    expect(screen.getByTestId("inspect-toggle")).toBeEnabled();
  });

  it("F4: after a save the new head has no mesh, so its local render shows; when a display render fails, the last server render shows, labelled as older", async () => {
    const firstMesh = server.buildMesh("p1");
    render(<App />);
    await openEdit();
    await waitFor(() => expect(viewerUrl()).toBe(firstMesh), { timeout: 3000 });

    await saveWall("3");
    await waitFor(() => expect(viewerUrl()).toMatch(/^blob:fake-mesh-/), { timeout: 3000 });
    expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("Local edit preview — not built or validated.");

    engine.failing = true;
    clickButton("Undo");
    await waitFor(() => expect(status()).toHaveTextContent("could not be updated"), { timeout: 3000 });
    expect(viewerUrl()).toBe(firstMesh);
    expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("The local edit preview failed — showing the last server render, from before your saved edits.");
  });

  it("F4: with a historical snapshot selected, the viewer shows that snapshot's server mesh and no edit preview", async () => {
    const firstMesh = server.buildMesh("p1");
    render(<App />);
    await openEdit();
    await saveWall("3");
    fireEvent.click(screen.getByRole("tab", { name: /history/i }));
    await screen.findAllByTestId("snapshot-row");
    fireEvent.click(screen.getAllByTestId("snapshot-row").at(-1)!);
    await screen.findByText(/Viewing historical snapshot/);
    await waitFor(() => expect(viewerUrl()).toBe(firstMesh), { timeout: 3000 });
    expect(screen.queryByTestId("edit-preview-status")).toBeNull();
  });
});

describe("Edit surface — PR #140 fix batch 2", () => {
  function sourceReads(): number {
    return server.log.filter((line) => line === "GET /projects/p1/source").length;
  }

  function headerBuild(): HTMLElement {
    return within(screen.getByRole("banner")).getByRole("button", { name: /^Build$/ });
  }

  async function settle(ms = 30): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  it("F1(a): a failed post-commit source re-read keeps Build refused with a reason; Build retries it, then sends the post-commit revision", async () => {
    render(<App />);
    await openEdit();
    server.failSourceGet.add("p1");
    const readsBefore = sourceReads();
    await saveWall("3");
    await waitFor(() => expect(sourceReads()).toBe(readsBefore + 1), { timeout: 3000 });
    await settle();
    expect(screen.getByTestId("preview-build-button")).toHaveAttribute("title", "The latest source could not be loaded. Press Build to try loading it again.");

    fireEvent.click(headerBuild());
    await screen.findByText(/The latest source could not be loaded; trying again/);
    expect(server.buildPosts).toHaveLength(0);
    await waitFor(() => expect(sourceReads()).toBe(readsBefore + 2), { timeout: 3000 });
    await settle();

    fireEvent.click(headerBuild());
    await waitFor(() => expect(server.buildPosts).toHaveLength(1), { timeout: 3000 });
    expect(server.buildPosts[0].current).toBe(true);
  });

  it("F1(b): a draft dirty at the receipt, then discarded, triggers the re-read; Build then sends the post-commit revision", async () => {
    render(<App />);
    await openEdit();
    const hold = server.hold("commit");
    typeWall("3");
    clickButton("Save");
    await hold.arrived;
    fireEvent.click(screen.getByRole("tab", { name: /code/i }));
    await screen.findByLabelText("OpenSCAD source");
    await settle(20);
    fireEvent.change(screen.getByLabelText("OpenSCAD source"), { target: { value: "cube([wall, 12, 10]); // draft" } });
    hold.release();
    await waitFor(() => expect(server.acceptedCommits).toBe(1));
    await settle(50);
    const readsBefore = sourceReads();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(sourceReads()).toBe(readsBefore + 1), { timeout: 3000 });
    await settle();
    fireEvent.click(headerBuild());
    await waitFor(() => expect(server.buildPosts).toHaveLength(1), { timeout: 3000 });
    expect(server.buildPosts[0].current).toBe(true);
  });

  it("F4: a mesh result for project A, rendered with project B current, is never shown or kept for B", async () => {
    server = seedServer("p1", "p2");
    vi.stubGlobal("fetch", server.fetch);
    const meshA = server.buildMesh("p1");
    const headA = server.projects.get("p1")!.snapshots[0].id;
    render(<App />);
    await openEdit();
    await waitFor(() => expect(viewerUrl()).toBe(meshA), { timeout: 3000 });

    // The render the review describes: project B current, A's `ready` result still in hand.
    const resultForA: MeshResult = { url: meshA, status: "ready", projectId: "p1", snapshotId: headA };
    meshOverride.fn = (real, projectId) => (projectId === "p2" ? resultForA : real);
    const logged = viewer.log.length;
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } });
    await waitFor(() => expect(server.log).toContain("GET /projects/p2/editor"), { timeout: 3000 });
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    // B's preview fails: the fallback must not be A's mesh, and nothing may claim a server render.
    engine.failing = true;
    typeWall("4");
    clickButton("Preview");
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("The local edit preview failed"));
    await settle();
    expect(viewer.log.slice(logged)).not.toContain(meshA);
    expect(screen.getByTestId("edit-preview-status")).not.toHaveTextContent("showing the last server render");
  });

  it("F4: a historical snapshot's mesh result, rendered with the head selected again, is never shown or kept as the head's", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");
    const older = server.projects.get("p1")!.snapshots.at(-1)!.id;
    const olderMesh = server.buildSnapshotMesh("p1", older);
    fireEvent.click(screen.getByRole("tab", { name: /history/i }));
    await screen.findAllByTestId("snapshot-row");
    fireEvent.click(screen.getAllByTestId("snapshot-row").at(-1)!);
    await screen.findByText(/Viewing historical snapshot/);
    await waitFor(() => expect(viewerUrl()).toBe(olderMesh), { timeout: 3000 });

    // The head is selected again while the historical snapshot's `ready` result is still in hand.
    const resultForOlder: MeshResult = { url: olderMesh, status: "ready", projectId: "p1", snapshotId: older };
    meshOverride.fn = (real, _projectId, snapshotId) => (snapshotId !== older ? resultForOlder : real);
    const logged = viewer.log.length;
    fireEvent.click(screen.getByRole("button", { name: "Return to current" }));
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    engine.failing = true;
    typeWall("5");
    clickButton("Preview");
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("The local edit preview failed"));
    await settle();
    expect(viewer.log.slice(logged)).not.toContain(olderMesh);
  });

  it("L4: until the head moves off the pre-commit snapshot, its mesh is not shown as current and Inspect stays off", async () => {
    const preCommitMesh = server.buildMesh("p1");
    render(<App />);
    await openEdit();
    await waitFor(() => expect(viewerUrl()).toBe(preCommitMesh), { timeout: 3000 });

    const list = server.hold("snapshots-list");
    await saveWall("3");
    await list.arrived;
    await settle(50);
    expect(screen.getByTestId("edit-preview-status")).toBeInTheDocument();
    expect(viewerUrl()).toMatch(/^blob:fake-mesh-/);
    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();

    // The new head gets a mesh; the list catches up and the state resolves to it.
    const newHeadMesh = server.buildMesh("p1");
    list.release();
    await waitFor(() => expect(viewerUrl()).toBe(newHeadMesh), { timeout: 3000 });
    expect(screen.queryByTestId("edit-preview-status")).toBeNull();
    expect(screen.getByTestId("inspect-toggle")).toBeEnabled();
  });

  it("L4: when the snapshot list refresh fails, the edit preview says why and Retry recovers", async () => {
    const preCommitMesh = server.buildMesh("p1");
    render(<App />);
    await openEdit();
    await waitFor(() => expect(viewerUrl()).toBe(preCommitMesh), { timeout: 3000 });

    server.failSnapshotsList.add("p1");
    await saveWall("3");
    await screen.findByTestId("edit-preview-notice");
    expect(viewerUrl()).not.toBe(preCommitMesh);
    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();

    fireEvent.click(within(screen.getByTestId("edit-preview-notice")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("edit-preview-notice")).toBeNull(), { timeout: 3000 });
    // The new head has no mesh: the local preview keeps the viewer, labelled.
    expect(viewerUrl()).toMatch(/^blob:fake-mesh-/);
  });

  it("while the head's mesh is still being checked, the label says so instead of claiming there is none", async () => {
    server.buildMesh("p1");
    const probe = server.hold("mesh");
    engine.mode = "manual";
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Edit" }));
    await probe.arrived;
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("Checking for a server render of this project"), { timeout: 3000 });
    expect(screen.getByTestId("edit-preview-status")).not.toHaveTextContent("There is no server render");
    probe.release();
  });
});

describe("Edit surface — PR #140 fix batch 3", () => {
  async function settle(ms = 30): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  function headerBuild(): HTMLElement {
    return within(screen.getByRole("banner")).getByRole("button", { name: /^Build$/ });
  }

  it("F7: a project with no snapshot shows the first-run text, not 'Loading model…', and the Edit preview claims no check", async () => {
    server = new FakeEditorServer([{ id: "p1", values: { wall: 2 }, features: [WALL_FEATURE], withoutSnapshot: true }]);
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await waitFor(() => expect(server.log).toContain("GET /projects/p1/snapshots"), { timeout: 3000 });
    await settle(50);
    expect(screen.getByText("No render yet. Send a message to generate the first model.")).toBeInTheDocument();
    expect(screen.queryByText("Loading model…")).toBeNull();

    // Edit tab: the local preview fails, and there is no head whose server render could be "being checked".
    engine.failing = true;
    await openEdit();
    await waitFor(() => expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("The local edit preview failed"));
    await settle();
    expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("There is no server render of this project to show");
    expect(screen.getByTestId("edit-preview-status")).not.toHaveTextContent("Checking for a server render");
  });

  it("L4: after saves H1 then H2, a list whose head is H1 (with a server mesh) does not end the wait; a list containing H2 does", async () => {
    server.buildMesh("p1");
    render(<App />);
    await openEdit();
    const first = server.hold("snapshots-list");
    await saveWall("3");
    await first.arrived;
    const second = server.hold("snapshots-list");
    await saveWall("4");
    await second.arrived;
    const [h2, h1] = server.projects.get("p1")!.snapshots;
    const h1Mesh = server.buildSnapshotMesh("p1", h1.id);

    // The applied list read is stale: its head is H1, and H1 has a server mesh.
    server.snapshotListOverride = (projectId) => (projectId === "p1" ? server.projects.get("p1")!.snapshots.filter((s) => s.id !== h2.id) : null);
    const logged = viewer.log.length;
    first.release();
    second.release();
    await settle(50);
    expect(viewer.log.slice(logged)).not.toContain(h1Mesh);
    expect(screen.getByTestId("edit-preview-notice")).toBeInTheDocument();
    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();

    // A list containing H2 ends the wait.
    server.snapshotListOverride = null;
    fireEvent.click(within(screen.getByTestId("edit-preview-notice")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("edit-preview-notice")).toBeNull(), { timeout: 3000 });
    expect(viewer.log.slice(logged)).not.toContain(h1Mesh);
  });

  it("F8: a revert started in project A that completes after a switch to B does nothing to B's session or selection", async () => {
    server = seedServer("p1", "p2");
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await openEdit();
    await saveWall("3");
    fireEvent.click(screen.getByRole("tab", { name: /history/i }));
    await screen.findAllByTestId("snapshot-row");
    fireEvent.click(screen.getAllByTestId("snapshot-row").at(-1)!);
    const lateRevert = server.hold("revert");
    fireEvent.click(await screen.findByTestId("revert-trigger"));
    fireEvent.click(await screen.findByTestId("revert-confirm-yes"));
    await lateRevert.arrived;

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } });
    await waitFor(() => expect(server.log).toContain("GET /projects/p2/editor"), { timeout: 3000 });
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() => expect(status()).toHaveTextContent("Ready."), { timeout: 3000 });
    await saveWall("4");
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());
    typeWall("5");
    clickButton("Preview");
    await waitFor(() => expect(status()).toHaveTextContent("Preview ready."), { timeout: 3000 });
    const p2Reads = server.log.filter((line) => line === "GET /projects/p2/editor").length;

    lateRevert.release();
    await settle(50);
    expect(status()).toHaveTextContent("Preview ready.");
    expect(server.log.filter((line) => line === "GET /projects/p2/editor")).toHaveLength(p2Reads);
    expect(screen.queryByText(/Viewing historical snapshot/)).toBeNull();
    clickButton("Cancel");
    await waitFor(() => expect(status()).toHaveTextContent("Ready."));
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("Build: after a switch, while B's source read is out, Build sends nothing and says why; then it posts B's revision", async () => {
    server = seedServer("p1", "p2");
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await waitFor(() => expect(server.log).toContain("GET /projects/p1/source"), { timeout: 3000 });
    await settle(50);
    const read = server.hold("source-get");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } });
    await read.arrived;

    fireEvent.click(headerBuild());
    await screen.findByText("Loading the latest source before building…");
    expect(server.buildPosts).toHaveLength(0);

    read.release();
    await settle(50);
    fireEvent.click(headerBuild());
    await waitFor(() => expect(server.buildPosts).toHaveLength(1), { timeout: 3000 });
    expect(server.buildPosts[0]).toMatchObject({ projectId: "p2", current: true });
  });

  it("Build: after a switch, a failed read of B's source keeps Build from posting; Build retries the read, then posts B's revision", async () => {
    server = seedServer("p1", "p2");
    vi.stubGlobal("fetch", server.fetch);
    const p2Reads = () => server.log.filter((line) => line === "GET /projects/p2/source").length;
    render(<App />);
    await waitFor(() => expect(server.log).toContain("GET /projects/p1/source"), { timeout: 3000 });
    await settle(50);
    server.failSourceGet.add("p2");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p2" } });
    await waitFor(() => expect(p2Reads()).toBe(1), { timeout: 3000 });
    await settle(50);
    expect(screen.getByTestId("preview-build-button")).toHaveAttribute("title", "The latest source could not be loaded. Press Build to try loading it again.");

    fireEvent.click(headerBuild());
    await screen.findByText(/The latest source could not be loaded; trying again/);
    expect(server.buildPosts).toHaveLength(0);
    await waitFor(() => expect(p2Reads()).toBe(2), { timeout: 3000 });
    await settle(50);

    fireEvent.click(headerBuild());
    await waitFor(() => expect(server.buildPosts).toHaveLength(1), { timeout: 3000 });
    expect(server.buildPosts[0]).toMatchObject({ projectId: "p2", current: true });
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

// ── Issue #143: Build re-probes the mesh for the snapshot already current ──

describe("Issue #143 — after save then Build the mesh is probed again for the same snapshot", () => {
  function headerBuild(): HTMLElement {
    return within(screen.getByRole("banner")).getByRole("button", { name: /^Build$/ });
  }

  /** Mesh probes issued so far (the useSnapshotMesh HEAD). */
  function meshProbes(): number {
    return server.log.filter((line) => line.startsWith("HEAD /projects/p1/snapshots/")).length;
  }

  it("after save then Build the server mesh replaces the local edit preview and Inspect and Measure are enabled", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");
    // The saved edit's head snapshot has no server mesh: the local preview shows.
    await waitFor(() => expect(viewerUrl()).toMatch(/^blob:fake-mesh-/), { timeout: 3000 });
    expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("Local edit preview — not built or validated.");
    expect(screen.getByTestId("inspect-toggle")).toBeDisabled();
    expect(screen.getByTestId("measure-toggle")).toBeDisabled();

    await waitFor(() => expect(headerBuild()).toBeEnabled(), { timeout: 3000 });
    fireEvent.click(headerBuild());
    await waitFor(() => expect(server.buildPosts).toHaveLength(1), { timeout: 3000 });
    expect(server.buildPosts[0].current).toBe(true);
    await screen.findByText(/Build complete/);

    // Build attached the mesh to the snapshot that was already current: the
    // viewer must receive it with no further user action.
    await waitFor(() => expect(viewerUrl()).toMatch(/^\/api\/projects\/p1\/snapshots\/[^/]+\/mesh$/), { timeout: 3000 });
    expect(screen.queryByTestId("edit-preview-status")).toBeNull();
    expect(screen.getByTestId("inspect-toggle")).toBeEnabled();
    expect(screen.getByTestId("measure-toggle")).toBeEnabled();
  });

  it("a failed Build keeps the local edit preview with its label and issues no further mesh probe", async () => {
    render(<App />);
    await openEdit();
    await saveWall("3");
    await waitFor(() => expect(viewerUrl()).toMatch(/^blob:fake-mesh-/), { timeout: 3000 });
    expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("Local edit preview — not built or validated.");
    await waitFor(() => expect(headerBuild()).toBeEnabled(), { timeout: 3000 });
    const probesBefore = meshProbes();

    // Another tab writes params (no signal reaches this tab): the editor's
    // base revision is stale and Build answers 409.
    server.externalWrite("p1", { wall: 5 });
    fireEvent.click(headerBuild());
    await screen.findByText(/The source changed since this revision/);
    expect(server.buildPosts).toHaveLength(1);
    expect(server.buildPosts[0].current).toBe(false);

    // The labelled local preview stays, no error boundary appears, and no
    // further mesh probe is issued (no loop).
    expect(screen.getByTestId("edit-preview-status")).toHaveTextContent("Local edit preview — not built or validated.");
    expect(viewerUrl()).toMatch(/^blob:fake-mesh-/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(meshProbes()).toBe(probesBefore);
  });
});
