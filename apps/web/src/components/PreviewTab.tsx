import { useState } from "react";
import { VIEW_NAMES, type ViewName } from "@scadforge/protocol";
import { Viewer3D } from "./Viewer3D.js";

/** The four fixed views shown as buttons (Issue #18 AC — `section` is excluded from this round's view switcher). */
const PREVIEW_VIEW_BUTTONS: ViewName[] = VIEW_NAMES.filter(
  (view): view is Exclude<ViewName, "section"> => view !== "section"
);

export interface PreviewTabProps {
  stlUrl: string | null;
  /** Server-rendered PNG URL per fixed view; null when that view hasn't been rendered. */
  pngUrls: Partial<Record<ViewName, string | null>>;
}

type PreviewMode = "orbit" | ViewName;

/** SDP §9 Preview tab: interactive three.js orbit view by default, with buttons to inspect a fixed server-rendered view (color-authoritative — the STL carries no color). */
export function PreviewTab({ stlUrl, pngUrls }: PreviewTabProps) {
  const [mode, setMode] = useState<PreviewMode>("orbit");

  const activePng = mode === "orbit" ? null : (pngUrls[mode] ?? null);

  return (
    <div className="preview-tab">
      <div className="preview-view-buttons" role="group" aria-label="Preview view">
        <button
          type="button"
          className={mode === "orbit" ? "active" : ""}
          onClick={() => setMode("orbit")}
        >
          3D
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
