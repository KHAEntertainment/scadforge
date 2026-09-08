import { useCallback, useEffect, useRef, useState } from "react";
import type { RemovedParam } from "@scadforge/protocol";
import { ApiClientError, type ApiClient } from "../lib/apiClient.js";

/**
 * Session-scoped recoverable draft persistence (Issue #54 AC). The draft is
 * stored as the triple {draftScad, baseRevision, savedScad} so a refresh can
 * restore the UNSAVED text AND the ORIGINAL revision it was based on. A draft
 * is only persisted while dirty; a clean editor leaves nothing to recover.
 */
interface PersistedDraft {
  draftScad: string;
  baseRevision: string;
  savedScad: string;
}

function draftKey(projectId: string): string {
  return `scadforge:source-draft:${projectId}`;
}

function loadDraft(projectId: string): PersistedDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(projectId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PersistedDraft).draftScad === "string" &&
      typeof (parsed as PersistedDraft).baseRevision === "string" &&
      typeof (parsed as PersistedDraft).savedScad === "string"
    ) {
      return parsed as PersistedDraft;
    }
    return null;
  } catch {
    return null;
  }
}

function saveDraft(projectId: string, draft: PersistedDraft): void {
  try {
    sessionStorage.setItem(draftKey(projectId), JSON.stringify(draft));
  } catch {
    // storage blocked / quota — the draft simply won't survive a refresh.
  }
}

function clearDraft(projectId: string): void {
  try {
    sessionStorage.removeItem(draftKey(projectId));
  } catch {
    // ignore — same as above.
  }
}

/** CRLF → LF so client and server agree on the exact bytes (Issue #40). */
function normalizeLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function describeSaveError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.error_code === "CONFLICT") {
      return "Another change was saved since you started editing. Discard and reload to see the current model before saving again.";
    }
    if (cause.error_code === "VALIDATION_FAILED") {
      return `This code doesn't parse yet: ${cause.message}`;
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : "Save failed unexpectedly.";
}

export interface SourceEditorResult {
  loading: boolean;
  loadError: string | null;
  /** Last source the server confirmed (the revert target for Discard). */
  savedScad: string | null;
  /** The current editable text. */
  draftScad: string;
  /** The opaque revision the draft is based on. Never silently rebased. */
  baseRevision: string | null;
  /** True when `draftScad` differs from `savedScad` (unsaved edits). */
  dirty: boolean;
  saving: boolean;
  /** Human-readable failure from the last preflight/save. */
  saveError: string | null;
  /** True when the draft's base revision is known-stale vs the server. */
  conflict: boolean;
  /** Removed/incompatible overrides awaiting explicit acknowledgment. */
  pendingRemoved: RemovedParam[] | null;
  setDraft: (text: string) => void;
  /** Revert unsaved edits back to the last server-confirmed source. */
  discard: () => void;
  /** Drop the draft entirely and adopt the server's current source + revision. */
  reload: () => void;
  /** Preflight, then (if needed) ask to acknowledge removed overrides, then PUT. */
  save: () => void;
  /** Confirm the pending override drop and proceed with the PUT. */
  acknowledgeSave: () => void;
  cancelAcknowledge: () => void;
}

/**
 * Drives the Code tab: loads `GET /source`, tracks a dirty draft, persists it
 * per project, and saves via preflight → acknowledge → PUT with
 * compare-and-swap (Issue #54). The original `baseRevision` is preserved
 * through the whole flow — a stale revision is surfaced as a conflict, never
 * silently rebased onto the server's current state.
 */
export function useSourceEditor(
  client: ApiClient,
  projectId: string | null,
  /** Invoked after a successful save, so the owner can refresh snapshots / head. */
  onSaved?: () => void
): SourceEditorResult {
  const [savedScad, setSavedScad] = useState<string | null>(null);
  const [draftScad, setDraftScad] = useState("");
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pendingRemoved, setPendingRemoved] = useState<RemovedParam[] | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  /** Gates persistence until the restore for THIS project has run. */
  const hydratedForRef = useRef<string | null>(null);
  const draftRef = useRef(draftScad);
  const savedRef = useRef(savedScad);
  const baseRef = useRef(baseRevision);
  const pendingRef = useRef(pendingRemoved);
  const savingRef = useRef(false);
  const onSavedRef = useRef(onSaved);

  onSavedRef.current = onSaved;
  draftRef.current = draftScad;
  savedRef.current = savedScad;
  baseRef.current = baseRevision;
  pendingRef.current = pendingRemoved;

  // ── load (project switch, first mount, or explicit reload) ────────────────
  useEffect(() => {
    if (!projectId) {
      hydratedForRef.current = null;
      setSavedScad(null);
      setDraftScad("");
      setBaseRevision(null);
      setDirty(false);
      setConflict(false);
      setPendingRemoved(null);
      setSaveError(null);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    client
      .getSource(projectId)
      .then((res) => {
        if (cancelled) return;
        const stored = loadDraft(projectId);
        if (stored) {
          // Restore the unsaved draft with its ORIGINAL base revision. A stale
          // base (server advanced while we were away) is kept and surfaced as
          // a conflict — never silently rebased.
          setSavedScad(stored.savedScad);
          setDraftScad(stored.draftScad);
          setBaseRevision(stored.baseRevision);
          setDirty(stored.draftScad !== stored.savedScad);
          setConflict(stored.baseRevision !== res.revision);
        } else {
          const normalized = normalizeLf(res.scad);
          setSavedScad(normalized);
          setDraftScad(normalized);
          setBaseRevision(res.revision);
          setDirty(false);
          setConflict(false);
        }
        setPendingRemoved(null);
        setSaveError(null);
        hydratedForRef.current = projectId;
      })
      .catch((cause) => {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : "Failed to load the model source.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, projectId, reloadToken]);

  // ── persistence (only while dirty; clean clears the draft) ────────────────
  useEffect(() => {
    if (!projectId || hydratedForRef.current !== projectId) return;
    if (dirty && baseRevision !== null && savedScad !== null) {
      saveDraft(projectId, { draftScad, baseRevision, savedScad });
    } else if (!dirty) {
      clearDraft(projectId);
    }
  }, [projectId, draftScad, baseRevision, savedScad, dirty]);

  const setDraft = useCallback((text: string) => {
    setDraftScad(text);
    setDirty(text !== savedRef.current);
    setSaveError(null);
    setPendingRemoved(null);
  }, []);

  const discard = useCallback(() => {
    setDraftScad(savedRef.current ?? "");
    setDirty(false);
    setSaveError(null);
    setPendingRemoved(null);
  }, []);

  const reload = useCallback(() => {
    if (!projectId) return;
    // Explicitly adopt the server's current state: drop the stored draft so
    // the load effect below re-fetches with no draft to restore.
    clearDraft(projectId);
    setReloadToken((token) => token + 1);
  }, [projectId]);

  const attemptPut = useCallback(
    async (text: string, base: string, discarded: string[]): Promise<void> => {
      if (!projectId) return;
      const res = await client.updateSource(projectId, {
        scad: text,
        base_revision: base,
        discarded_params: discarded
      });
      setSavedScad(res.scad);
      setBaseRevision(res.revision);
      setPendingRemoved(null);
      setSaveError(null);
      setConflict(false);
      // Advance base to the save result, but retain any newer typing the user
      // did while the PUT was in flight (never erase newer edits).
      setDirty(draftRef.current !== res.scad);
      onSavedRef.current?.();
    },
    [client, projectId]
  );

  const save = useCallback(() => {
    if (!projectId || savingRef.current) return;
    const text = normalizeLf(draftRef.current);
    const base = baseRef.current;
    if (base === null) return;

    savingRef.current = true;
    setSaving(true);
    setSaveError(null);

    client
      .preflightSource(projectId, { scad: text, base_revision: base })
      .then((pre) => {
        if (!pre.syntax_ok) {
          setSaveError(`This code doesn't parse yet: ${pre.diagnostics ?? "syntax error"}`);
          return;
        }
        if (pre.removed_params.length > 0) {
          setPendingRemoved(pre.removed_params);
          return;
        }
        return attemptPut(text, base, []);
      })
      .catch((cause) => {
        if (cause instanceof ApiClientError && cause.error_code === "CONFLICT") setConflict(true);
        setSaveError(describeSaveError(cause));
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }, [client, projectId, attemptPut]);

  const acknowledgeSave = useCallback(() => {
    if (!projectId || savingRef.current) return;
    const removed = pendingRef.current;
    if (!removed || removed.length === 0) return;
    const text = normalizeLf(draftRef.current);
    const base = baseRef.current;
    if (base === null) return;

    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    attemptPut(text, base, removed.map((p) => p.name))
      .catch((cause) => {
        if (cause instanceof ApiClientError && cause.error_code === "CONFLICT") setConflict(true);
        setSaveError(describeSaveError(cause));
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }, [client, projectId, attemptPut]);

  const cancelAcknowledge = useCallback(() => setPendingRemoved(null), []);

  return {
    loading,
    loadError,
    savedScad,
    draftScad,
    baseRevision,
    dirty,
    saving,
    saveError,
    conflict,
    pendingRemoved,
    setDraft,
    discard,
    reload,
    save,
    acknowledgeSave,
    cancelAcknowledge
  };
}
