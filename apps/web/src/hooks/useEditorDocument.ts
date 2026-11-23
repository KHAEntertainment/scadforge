// SPDX-License-Identifier: Apache-2.0
//
// S3-C C1 — the editor document cache (Issue #134 criterion 5).
//
// One cache per `useEditorDocument(client, projectId)` call: it re-reads
// whenever anything else writes the project and never applies a response to
// the wrong project.
//
//  - Re-read triggers (the story's external-write seam): `invalidate()` with
//    `params-saved`, `source-saved`, `reverted`, `chat-turn-ended` or
//    `conflict` (the criterion-4 definite-CONFLICT hook, normally wired to
//    `createEditorClient`'s `onDefiniteConflict`), plus a project switch and
//    an explicit `refresh()`.
//  - A response for a project other than the current one is dropped, never
//    painted (the render-time reset plus the effect cancellation below).
//  - `sidecarStatus` `missing`/`corrupt`/`unsupported-version` is surfaced as
//    document data — never retried, never treated as an empty editor.
//  - A failed read never yields a ready document: the failure is reported and
//    no stale document is kept as current authority.
//  - Each completed read exposes the `editorRevision` it returned, so a caller
//    holding a receipt for R1 can see the read returned a later R2. The cache
//    never waits for a specific revision.
//  - While a re-read is outstanding the cache reports `unsettled` (the first
//    read of a project is `loading` — Tech-Lead ruling R7). A chat stream that
//    DROPPED is not "turn ended": `invalidate("chat-stream-dropped")` sets a
//    sticky flag under which completed re-reads may update the document but
//    the status stays `unsettled`, until `invalidate("chat-turn-ended")`
//    (the `useChat` reconciliation signal), a project switch or `refresh()`
//    clears it (R5). No wiring into `useChat` or any component lives here —
//    C4 owns wiring.

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorDocument } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

/**
 * Why the cache was invalidated (the external-write seam). `chat-stream-dropped`
 * is the odd one out: it marks the cache unsettled WITHOUT re-reading (R5).
 */
export type InvalidateReason =
  | "params-saved"
  | "source-saved"
  | "reverted"
  | "chat-turn-ended"
  | "chat-stream-dropped"
  | "conflict";

/**
 * `loading` is only the first read of a project; every later outstanding read
 * is `unsettled` (R7).
 */
export type EditorDocumentStatus = "idle" | "loading" | "unsettled" | "ready" | "error";

export interface UseEditorDocumentResult {
  /** The last successful read's document; `null` before one and after a failed read (never stale authority). */
  document: EditorDocument | null;
  /** The `editorRevision` the last COMPLETED read returned (criterion 5's receipt-comparison surface). */
  editorRevision: string | null;
  status: EditorDocumentStatus;
  /** The last read failure (`status === "error"`), else `null`. */
  error: unknown;
  /** Force a re-read now; also the R5 escape hatch that clears the dropped-stream flag. */
  refresh(): void;
  /** The external-write seam: report why the project changed under the cache. */
  invalidate(reason: InvalidateReason): void;
}

interface CacheState {
  document: EditorDocument | null;
  editorRevision: string | null;
  status: EditorDocumentStatus;
  error: unknown;
}

function idleState(): CacheState {
  return { document: null, editorRevision: null, status: "idle", error: null };
}

export function useEditorDocument(
  client: ApiClient,
  projectId: string | null
): UseEditorDocumentResult {
  const [state, setState] = useState<CacheState>(() =>
    projectId === null ? idleState() : { document: null, editorRevision: null, status: "loading", error: null }
  );
  const [trackedProjectId, setTrackedProjectId] = useState(projectId);
  const [readToken, setReadToken] = useState(0);

  // Sticky dropped-stream flag (R5). While set, completed re-reads may update
  // the document data but the status never becomes `ready`.
  const droppedRef = useRef(false);
  // Whether the CURRENT project has had a read started (R7: `loading` is only
  // the first read of a project).
  const startedRef = useRef(false);

  // Criterion 5, old-project rule (mirrors useSnapshots' Issue #79 reset):
  // reset synchronously, DURING RENDER, the instant `projectId` changes, so
  // the first render with the new project never carries the old project's
  // document — and a response for the old project that resolves late is
  // dropped by the effect cancellation below, never painted.
  if (projectId !== trackedProjectId) {
    setTrackedProjectId(projectId);
    droppedRef.current = false;
    startedRef.current = false;
    setState(projectId === null ? idleState() : { document: null, editorRevision: null, status: "loading", error: null });
  }

  useEffect(() => {
    if (projectId === null) return;
    const first = !startedRef.current;
    startedRef.current = true;
    // R7: `loading` only for the project's first read; every later outstanding
    // read reports `unsettled`.
    setState((s) => ({ ...s, status: first ? "loading" : "unsettled" }));
    let cancelled = false;
    client.getEditorDocument(projectId).then(
      (document) => {
        // `cancelled` covers both drop cases: a project switch/unmount, and a
        // newer read of the same project superseding this one (latest wins).
        if (cancelled) return;
        setState({
          document,
          editorRevision: document.editorRevision,
          // R5: under the dropped-stream flag the data may update but the
          // status does not become `ready`.
          status: droppedRef.current ? "unsettled" : "ready",
          error: null
        });
      },
      (cause) => {
        if (cancelled) return;
        // Criterion 5: a failed read never yields a ready document and keeps
        // no stale document as current authority.
        setState({ document: null, editorRevision: null, status: "error", error: cause });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [client, projectId, readToken]);

  const refresh = useCallback(() => {
    // R5: the explicit escape hatch — a dismissed `connection_lost` item must
    // never strand the editor; whether dismissal calls this is C4's wiring.
    droppedRef.current = false;
    setReadToken((token) => token + 1);
  }, []);

  const invalidate = useCallback(
    (reason: InvalidateReason) => {
      if (projectId === null) return;
      if (reason === "chat-stream-dropped") {
        // R5: outcome unknown — mark unsettled and do NOT re-read yet ("the
        // cache stays unsettled until useChat's reconciliation reports the
        // turn's outcome, then re-reads").
        droppedRef.current = true;
        setState((s) => (s.status === "idle" ? s : { ...s, status: "unsettled" }));
        return;
      }
      if (reason === "chat-turn-ended") droppedRef.current = false;
      setReadToken((token) => token + 1);
    },
    [projectId]
  );

  return {
    document: state.document,
    editorRevision: state.editorRevision,
    status: state.status,
    error: state.error,
    refresh,
    invalidate
  };
}
