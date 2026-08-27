import { useState } from "react";
import { VIEW_NAMES, type ParamValues, type ViewName } from "@scadforge/protocol";
import { Viewer3D } from "./Viewer3D.js";
import { useWasmPreview } from "../wasm/index.js";

/** The four fixed views shown as buttons (Issue #18 AC — `section` is excluded from this round's view switcher). */
const PREVIEW_VIEW_BUTTONS: ViewName[] = VIEW_NAMES.filter(
  (view): view is Exclude<ViewName, "section"> => view !== "section"
);

export interface PreviewTabProps {
  /** Server-authoritative mesh URL (PROJECT_CONTEXT.md "Render authority"). */
  stlUrl: string | null;
  /** Server-rendered PNG URL per fixed view; null when that view hasn't been rendered. */
  pngUrls: Partial<Record<ViewName, string | null>>;
  /** Current model source + params for the WASM live preview (Issue #31); null while the project hasn't loaded yet. */
  liveScad: string | null;
  liveParams: ParamValues;
}

type PreviewMode = "orbit" | "live" | ViewName;

const LIVE_STATUS_LABEL: Record<string, string> = {
  idle: "Live preview idle.",
  pending: "Rendering live preview…",
  ok: "Live preview.",
  error: "Live preview failed to compile — showing last server render.",
  timeout: "Live preview timed out — showing last server render.",
  fatal: "Live preview crashed — showing last server render."
};

/** SDP §9 Preview tab: interactive three.js orbit view by default, with buttons to inspect a fixed server-rendered view (color-authoritative — the STL carries no color), plus an opt-in WASM "Live" preview (Issue #31). */
export function PreviewTab({ stlUrl, pngUrls, liveScad, liveParams }: PreviewTabProps) {
  const [mode, setMode] = useState<PreviewMode>("orbit");
  const isLive = mode === "live";

  // `enabled: isLive` — the worker is only spawned while the Live tab is
  // actually selected, not on every project/param change.
  const wasm = useWasmPreview(liveScad, liveParams, isLive);
  const isStale = wasm.status !== "ok"; // AC: server-authority fallback + stale indicator, never blank

  const activePng = mode === "orbit" || mode === "live" ? null : (pngUrls[mode] ?? null);

  return (
    <div className="preview-tab">
      <div className="preview-view-buttons" role="group" aria-label="Preview view">
        <button type="button" className={mode === "orbit" ? "active" : ""} onClick={() => setMode("orbit")}>
          3D
        </button>
        <button
          type="button"
          className={mode === "live" ? "active" : ""}
          onClick={() => setMode("live")}
          data-testid="view-button-live"
          disabled={liveScad === null}
        >
          Live
        </button>
        {PREVIEW_VIEW_BUTTONS.map((view) => (
          <button
            key={view}
            type="button"
            className={mode === view ? "active" : ""}
            onClick={() => setMode(view)}
            data-testid={`view-button-${view}`}
          >
            {view}
          </button>
        ))}
      </div>

      {mode === "orbit" ? (
        <Viewer3D stlUrl={stlUrl} />
      ) : mode === "live" ? (
        <div className="preview-live">
          <div
            className={`live-status live-status--${isStale ? "stale" : "live"}`}
            role="status"
            data-testid={isStale ? "live-stale-indicator" : "live-status"}
          >
            {LIVE_STATUS_LABEL[wasm.status]}
            {isStale && wasm.stderr ? <span className="live-stderr"> {wasm.stderr}</span> : null}
          </div>
          {/* Server-authority fallback (CLAUDE.md rule 6, binding): while not
              `ok`, this keeps showing the last SERVER-rendered mesh (never a
              blank canvas) with the stale indicator above. */}
          <Viewer3D stlUrl={isStale ? stlUrl : wasm.objectUrl} />
        </div>
      ) : activePng ? (
        <img className="preview-png" src={activePng} alt={`${mode} view render`} />
      ) : (
        <div className="viewer-placeholder" data-testid="viewer-placeholder">
          No {mode} render yet.
        </div>
      )}
    </div>
  );
}
