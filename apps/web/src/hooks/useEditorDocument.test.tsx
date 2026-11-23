// SPDX-License-Identifier: Apache-2.0
//
// S3-C C1 — editor document cache tests (Issue #134 criterion 9 and Tech-Lead
// ruling R5): the five re-read triggers, the dropped late response after a
// project switch, each sidecar status surfaced without a retry, a failed read,
// a read that returns a revision later than a held receipt, and the
// dropped-stream case. The `useChat` signal wiring itself is C4's (R5); these
// tests drive the cache's seam with the exact reasons that signal produces.

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorDocument, EditorSidecarStatus } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";
import { useEditorDocument } from "./useEditorDocument.js";

const HEX64 = "a".repeat(64);
const REV_R1 = "1".repeat(64);
const REV_R2 = "2".repeat(64);

function doc(projectId: string, overrides: Partial<EditorDocument> = {}): EditorDocument {
  return {
    version: 1,
    projectId,
    head: null,
    sourceRevision: HEX64,
    sourceFingerprint: HEX64,
    editorRevision: REV_R2,
    scad: "cube(10);",
    parameters: [],
    values: {},
    sidecar: { version: 1, features: [] },
    sidecarStatus: "ready",
    eligibility: [],
    ...overrides
  };
}

interface PendingRead {
  projectId: string;
  resolve: (document: EditorDocument) => void;
  reject: (cause: unknown) => void;
}

function makeClient() {
  const reads: PendingRead[] = [];
  const getEditorDocument = vi.fn(
    (projectId: string) =>
      new Promise<EditorDocument>((resolve, reject) => {
        reads.push({ projectId, resolve, reject });
      })
  );
  const client = { getEditorDocument } as unknown as ApiClient;
  return { client, reads };
}

describe("useEditorDocument — the five re-read triggers (Issue #134 criterion 5)", () => {
  it("re-reads after a params save, a source save, a revert, a chat turn ending, and a project switch", async () => {
    const { client, reads } = makeClient();
    const { result, rerender } = renderHook(({ projectId }) => useEditorDocument(client, projectId), {
      initialProps: { projectId: "proj-a" as string | null }
    });

    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(doc("proj-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    for (const reason of ["params-saved", "source-saved", "reverted", "chat-turn-ended"] as const) {
      const before = reads.length;
      act(() => result.current.invalidate(reason));
      await waitFor(() => expect(reads.length).toBe(before + 1));
      expect(reads[before].projectId).toBe("proj-a");
      reads[before].resolve(doc("proj-a"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
    }
    expect(reads).toHaveLength(5);

    rerender({ projectId: "proj-b" });
    await waitFor(() => expect(reads).toHaveLength(6));
    expect(reads[5].projectId).toBe("proj-b");
    reads[5].resolve(doc("proj-b"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document?.projectId).toBe("proj-b");
  });

  it("reports loading only for a project's first read; later outstanding reads are unsettled (R7)", async () => {
    const { client, reads } = makeClient();
    const { result } = renderHook(() => useEditorDocument(client, "proj-a"));

    await waitFor(() => expect(reads).toHaveLength(1));
    expect(result.current.status).toBe("loading");
    reads[0].resolve(doc("proj-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.invalidate("params-saved"));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(result.current.status).toBe("unsettled");
    reads[1].resolve(doc("proj-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });
});

describe("useEditorDocument — the old-project rule (Issue #134 criterion 5)", () => {
  it("drops a response that resolves after a project switch, never painting it", async () => {
    const { client, reads } = makeClient();
    const { result, rerender } = renderHook(({ projectId }) => useEditorDocument(client, projectId), {
      initialProps: { projectId: "proj-a" as string | null }
    });

    await waitFor(() => expect(reads).toHaveLength(1));
    rerender({ projectId: "proj-b" });
    await waitFor(() => expect(reads).toHaveLength(2));

    reads[1].resolve(doc("proj-b", { editorRevision: REV_R2 }));
    await waitFor(() => expect(result.current.document?.projectId).toBe("proj-b"));

    // The OLD project's read resolves late — it must be dropped entirely.
    reads[0].resolve(doc("proj-a", { editorRevision: REV_R1 }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.document?.projectId).toBe("proj-b");
    expect(result.current.editorRevision).toBe(REV_R2);
    expect(result.current.status).toBe("ready");
  });
});

describe("useEditorDocument — sidecar statuses are data, never a retry (Issue #134 criterion 5)", () => {
  const statuses: EditorSidecarStatus[] = ["missing", "corrupt", "unsupported-version"];
  it.each(statuses)("surfaces sidecarStatus %s as document data with exactly one read", async (sidecarStatus) => {
    const { client, reads } = makeClient();
    const { result } = renderHook(() => useEditorDocument(client, "proj-a"));

    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(doc("proj-a", { sidecarStatus }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.document?.sidecarStatus).toBe(sidecarStatus);
    // Never treated as an empty editor: the document is present as read…
    expect(result.current.document?.scad).toBe("cube(10);");
    // …and never retried.
    expect(reads).toHaveLength(1);
  });
});

describe("useEditorDocument — failure and revision semantics (Issue #134 criterion 5)", () => {
  it("a failed read never yields a ready document and leaves no stale document as authority", async () => {
    const { client, reads } = makeClient();
    const { result } = renderHook(() => useEditorDocument(client, "proj-a"));

    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(doc("proj-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document).not.toBeNull();

    act(() => result.current.invalidate("reverted"));
    await waitFor(() => expect(reads).toHaveLength(2));
    reads[1].reject(new Error("server exploded"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.document).toBeNull();
    expect(result.current.editorRevision).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("exposes the editorRevision each completed read returned, so a caller sees a later revision than a held receipt", async () => {
    const { client, reads } = makeClient();
    const { result } = renderHook(() => useEditorDocument(client, "proj-a"));

    // The caller holds a receipt for R1…
    const heldReceiptRevision = REV_R1;
    await waitFor(() => expect(reads).toHaveLength(1));
    // …but the current document reads back at R2.
    reads[0].resolve(doc("proj-a", { editorRevision: REV_R2 }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.editorRevision).toBe(REV_R2);
    expect(result.current.editorRevision).not.toBe(heldReceiptRevision);
    // The cache never waits for a specific revision — it reports the current one.
  });
});

describe("useEditorDocument — the dropped-stream case (R5)", () => {
  it("stays unsettled after a chat-stream-dropped, re-reads on other triggers without settling, then settles on chat-turn-ended", async () => {
    const { client, reads } = makeClient();
    const { result } = renderHook(() => useEditorDocument(client, "proj-a"));

    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(doc("proj-a", { editorRevision: REV_R1 }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // The stream dropped: outcome unknown — unsettled, and no re-read yet.
    act(() => result.current.invalidate("chat-stream-dropped"));
    expect(result.current.status).toBe("unsettled");
    expect(reads).toHaveLength(1);

    // Another external write while the flag is set: the read happens and the
    // data may update, but the status does not become ready.
    act(() => result.current.invalidate("params-saved"));
    await waitFor(() => expect(reads).toHaveLength(2));
    reads[1].resolve(doc("proj-a", { editorRevision: REV_R2 }));
    await waitFor(() => expect(result.current.document?.editorRevision).toBe(REV_R2));
    expect(result.current.status).toBe("unsettled");

    // useChat's reconciliation reports the turn's outcome → re-read → ready.
    act(() => result.current.invalidate("chat-turn-ended"));
    await waitFor(() => expect(reads).toHaveLength(3));
    reads[2].resolve(doc("proj-a", { editorRevision: REV_R2 }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("refresh() is the escape hatch: it clears the dropped-stream flag and re-reads", async () => {
    const { client, reads } = makeClient();
    const { result } = renderHook(() => useEditorDocument(client, "proj-a"));

    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(doc("proj-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.invalidate("chat-stream-dropped"));
    expect(result.current.status).toBe("unsettled");

    act(() => result.current.refresh());
    await waitFor(() => expect(reads).toHaveLength(2));
    reads[1].resolve(doc("proj-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("a project switch clears the dropped-stream flag", async () => {
    const { client, reads } = makeClient();
    const { result, rerender } = renderHook(({ projectId }) => useEditorDocument(client, projectId), {
      initialProps: { projectId: "proj-a" as string | null }
    });

    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(doc("proj-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.invalidate("chat-stream-dropped"));
    expect(result.current.status).toBe("unsettled");

    rerender({ projectId: "proj-b" });
    await waitFor(() => expect(reads).toHaveLength(2));
    reads[1].resolve(doc("proj-b"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document?.projectId).toBe("proj-b");
  });
});

describe("useEditorDocument — idle project (R6)", () => {
  it("projectId null is idle and never fetches", async () => {
    const { client, reads } = makeClient();
    const { result } = renderHook(() => useEditorDocument(client, null));

    expect(result.current.status).toBe("idle");
    expect(result.current.document).toBeNull();
    act(() => result.current.invalidate("params-saved"));
    act(() => result.current.refresh());
    await act(async () => {
      await Promise.resolve();
    });
    expect(reads).toHaveLength(0);
  });
});
