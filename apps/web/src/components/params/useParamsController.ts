import { useCallback, useEffect, useRef, useState } from "react";
import type { ParamDefinitionWire, ParamValue, ParamValues } from "@scadforge/protocol";
import type { ApiClient } from "../../lib/apiClient.js";

/**
 * Trailing debounce window for both effects of a control change (Issue #33
 * AC): the debounced WASM live-preview recompile AND the persisted server
 * PUT. Sharing one timer/coalescing path is what keeps a rapid slider drag
 * from firing either one per animation frame — see `setValue` below.
 */
export const PARAMS_DEBOUNCE_MS = 300;

export interface ParamsControllerResult {
  loading: boolean;
  loadError: string | null;
  title: string | null;
  parameters: ParamDefinitionWire[];
  /** Live UI values — every keystroke/drag updates this immediately. */
  values: ParamValues;
  /**
   * `values`, `PARAMS_DEBOUNCE_MS` after the last edit. Feed this (not
   * `values`) into the WASM live preview so a drag doesn't spawn a worker
   * render per intermediate frame (~1.6s/render per the WASM spike).
   */
  debouncedValues: ParamValues;
  /** Parameter names with a local edit not yet confirmed by the server. */
  dirty: ReadonlySet<string>;
  /** True while a PUT is in flight. */
  saving: boolean;
  /** Message from the most recently REJECTED PUT; cleared on the next successful one. */
  saveError: string | null;
  setValue: (name: string, value: ParamValue) => void;
}

/**
 * Drives the Params tab's schema + values, split from `ParamsTab.tsx` per
 * this repo's "pure logic, component-tested separately" convention (see
 * `chatReducer.ts`, `useLiveModelSource.ts`).
 *
 * ── Rapid successive writes (this project's own "hard way" note + #44) ────
 * Every `setValue` call updates `values` (and the visible control) at once,
 * but the PUT + the value handed to the WASM preview both settle
 * `PARAMS_DEBOUNCE_MS` after the LAST edit. While a PUT is in flight, a
 * further edit does not fire a second overlapping request (`params.json` has
 * no cross-request lock, #44) — it sets a "send again" flag consumed the
 * instant the in-flight request finishes, so the server always eventually
 * sees the latest values with at most one request in flight at a time. No
 * update is ever silently dropped.
 *
 * ── Agent-vs-user conflict policy (documented per #33 AC) ──────────────────
 * `headSnapshotId` changing (an agent turn's `set_params`/`write_scad`, a
 * manual save, or a revert, all surfaced via `snapshot_created` over SSE and
 * threaded down from `useChat`) triggers a schema+values refetch so the tab
 * picks up new/removed parameters. When merging the refetched values back in:
 * for any parameter name the user is currently mid-edit on (`dirty`), the
 * LOCAL value wins and the incoming server value for that name is discarded;
 * every other parameter adopts the server's value. This means a local edit
 * is never clobbered by a concurrent agent update — it is simply given
 * priority until it resolves (or is rejected and reverted), at which point
 * the next reconciliation (or that PUT's own response) brings it in line
 * with the server again. There is no merge at the single-parameter level
 * beyond that: a param is either "mine right now" or "theirs right now".
 */
export function useParamsController(
  client: ApiClient,
  projectId: string | null,
  headSnapshotId: string | null
): ParamsControllerResult {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [parameters, setParameters] = useState<ParamDefinitionWire[]>([]);
  const [values, setValues] = useState<ParamValues>({});
  const [debouncedValues, setDebouncedValues] = useState<ParamValues>({});
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Last values the SERVER has confirmed (a GET, or a successful PUT's echo) — the revert target on a rejected PUT. */
  const committedRef = useRef<ParamValues>({});
  const dirtyRef = useRef<Set<string>>(new Set());
  const valuesRef = useRef<ParamValues>({});
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const resendRef = useRef(false);
  const lastReconciledSnapshotRef = useRef<string | null>(null);

  valuesRef.current = values;

  const load = useCallback(
    (mode: "reset" | "reconcile") => {
      if (!projectId) return;
      if (mode === "reset") setLoading(true);
      setLoadError(null);
      client
        .getParams(projectId)
        .then((res) => {
          setTitle(res.title);
          setParameters(res.parameters);
          committedRef.current = res.values;
          if (mode === "reconcile") {
            // Conflict policy (see doc comment above): keep any locally-dirty
            // value, adopt everything else from the server.
            setValues((prev) => {
              const next: ParamValues = { ...res.values };
              for (const name of dirtyRef.current) {
                if (name in prev) next[name] = prev[name];
              }
              return next;
            });
          } else {
            setValues(res.values);
            setDebouncedValues(res.values);
            dirtyRef.current = new Set();
            setDirty(new Set());
          }
        })
        .catch((cause) => {
          setLoadError(cause instanceof Error ? cause.message : "Failed to load parameters.");
        })
        .finally(() => {
          if (mode === "reset") setLoading(false);
        });
    },
    [client, projectId]
  );

  // Project (or first) load: full reset.
  useEffect(() => {
    lastReconciledSnapshotRef.current = null;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    dirtyRef.current = new Set();
    setDirty(new Set());
    load("reset");
    // `load` is memoized on the same [client, projectId] pair this effect is
    // keyed on, so including it does not change when this effect re-runs.
  }, [client, projectId, load]);

  // A new head snapshot (agent turn / manual save / revert): reconcile
  // without clobbering an in-flight user edit.
  useEffect(() => {
    if (headSnapshotId === null) return;
    if (headSnapshotId === lastReconciledSnapshotRef.current) return;
    lastReconciledSnapshotRef.current = headSnapshotId;
    load("reconcile");
  }, [headSnapshotId, load]);

  useEffect(
    () => () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    },
    []
  );

  const flush = useCallback(() => {
    if (!projectId) return;
    const names = Array.from(dirtyRef.current);
    if (names.length === 0) return;
    if (inFlightRef.current) {
      // A PUT is already in flight — never send a second overlapping
      // request (#44: no cross-request lock on params.json). Flag it so the
      // moment the in-flight one settles, the latest values go out.
      resendRef.current = true;
      return;
    }

    inFlightRef.current = true;
    setSaving(true);
    const diff: ParamValues = {};
    for (const name of names) diff[name] = valuesRef.current[name];

    client
      .updateParams(projectId, { values: diff })
      .then((res) => {
        setSaveError(null);
        committedRef.current = res.values;
        // Keep dirty only for names the user changed again WHILE this
        // request was in flight (compared against the diff just sent).
        const stillDirty = new Set(dirtyRef.current);
        for (const name of names) {
          if (valuesRef.current[name] === diff[name]) stillDirty.delete(name);
        }
        dirtyRef.current = stillDirty;
        setDirty(new Set(stillDirty));
        setValues((prev) => {
          const next = { ...prev };
          for (const [name, value] of Object.entries(res.values)) {
            if (!stillDirty.has(name)) next[name] = value;
          }
          return next;
        });
      })
      .catch((cause) => {
        // Server authority: a rejected value (wrong type, out of range,
        // unknown name) is never left showing in the UI as if it were
        // accepted — revert exactly the values this request attempted.
        setSaveError(cause instanceof Error ? cause.message : "Failed to save parameters.");
        // Computed synchronously, BEFORE the `setValues` call below: its
        // updater function runs on React's own schedule, not necessarily
        // before the `dirtyRef`/`setDirty` lines that follow it.
        const remainingDirty = new Set(dirtyRef.current);
        for (const name of names) remainingDirty.delete(name);
        dirtyRef.current = remainingDirty;
        setDirty(new Set(remainingDirty));
        setValues((prev) => {
          const next = { ...prev };
          for (const name of names) {
            if (name in committedRef.current) next[name] = committedRef.current[name];
            else delete next[name];
          }
          return next;
        });
      })
      .finally(() => {
        inFlightRef.current = false;
        setSaving(false);
        if (resendRef.current) {
          resendRef.current = false;
          flush();
        }
      });
  }, [client, projectId]);

  const setValue = useCallback(
    (name: string, value: ParamValue) => {
      setValues((prev) => ({ ...prev, [name]: value }));
      dirtyRef.current.add(name);
      setDirty(new Set(dirtyRef.current));

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        setDebouncedValues({ ...valuesRef.current });
        flush();
      }, PARAMS_DEBOUNCE_MS);
    },
    [flush]
  );

  return {
    loading,
    loadError,
    title,
    parameters,
    values,
    debouncedValues,
    dirty,
    saving,
    saveError,
    setValue
  };
}
