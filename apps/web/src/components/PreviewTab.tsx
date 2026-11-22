import { useEffect, useState } from "react";
import { VIEW_NAMES, type ParamValues, type ValidationSummary, type ViewName } from "@scadforge/protocol";
import { Viewer3D } from "./Viewer3D.js";
import { ValidationPanel } from "./ValidationPanel.js";
import { PreviewErrorBoundary } from "./PreviewErrorBoundary.js";
import { useWasmPreview } from "../wasm/index.js";
import { bboxSize, formatMm, AXES, type BBox } from "./measure.js";
import type { MeasureFocus } from "./DimensionOverlay.js";
import type { SnapshotMeshStatus } from "../hooks/useSnapshotMesh.js";
import { InspectReadout } from "./inspect/InspectReadout.js";
import type { InspectionOutcome } from "./inspect/inspectionTypes.js";

/** The four fixed views shown as buttons (Issue #18 AC — `section` is excluded from this round's view switcher). */
const PREVIEW_VIEW_BUTTONS: ViewName[] = VIEW_NAMES.filter(
  (view): view is Exclude<ViewName, "section"> => view !== "section"
);

export interface PreviewTabProps {
  /** Server-authoritative mesh URL (PROJECT_CONTEXT.md "Render authority"). */
  stlUrl: string | null;
  /** Why `stlUrl` is null, so the placeholder can say something useful (Issue #41). */
  meshStatus?: SnapshotMeshStatus;
  /** The snapshot being previewed; null before any snapshot exists. */
  snapshotId?: string | null;
  /** That snapshot's validation verdict; null when it was never validated. */
  validation?: ValidationSummary | null;
  /** Server-rendered PNG URL per fixed view; null when that view hasn't been rendered. */
  pngUrls: Partial<Record<ViewName, string | null>>;
  /** Current model source + params for the WASM live preview (Issue #31); null while the project hasn't loaded yet. */
  liveScad: string | null;
  liveParams: ParamValues;
  /** True while History has selected a snapshot older than the working head. */
  historical?: boolean;
  onReturnToCurrent?: () => void;
  /** Same handler as the header's Build button (Issue #78) — omitted, no inline Build CTA is rendered. */
  onBuild?: () => void;
  /** True while a build is in flight. */
  building?: boolean;
  /** Disables every inline Build action in this tab; mirrors the header button's own conditions. */
  buildDisabled?: boolean;
  /** Why the action is disabled right now, shown as each button's tooltip. Null/undefined when enabled. */
  buildDisabledReason?: string | null;
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

/** Explains an empty 3D viewport in terms of what actually happened (Issue #41). */
function meshPlaceholderMessage(status: SnapshotMeshStatus, snapshotId: string | null): string {
  switch (status) {
    case "checking":
      return "Loading model…";
    case "absent":
      // Names the actual fix (Build) rather than just describing the
      // symptom (Issue #78) — the "has no 3D mesh yet" / no "Send a message"
      // substrings are load-bearing for `App.demo-ux.test.tsx` (Issue #41),
      // so this appends the CTA sentence instead of replacing the copy.
      return snapshotId
        ? `Snapshot ${snapshotId} has no 3D mesh yet — Build validates the model and creates the mesh. The rendered views above are still available.`
        : "No 3D mesh for this snapshot yet. Build validates the model and creates the mesh.";
    case "ready":
    case "idle":
    default:
      return "No render yet. Send a message to generate the first model.";
  }
}

/** SDP §9 Preview tab: interactive three.js orbit view by default, with buttons to inspect a fixed server-rendered view (color-authoritative — the STL carries no color), plus an opt-in WASM "Live" preview (Issue #31). */
export function PreviewTab({
  stlUrl,
  meshStatus = "idle",
  snapshotId = null,
  validation = null,
  pngUrls,
  liveScad,
  liveParams,
  historical = false,
  onReturnToCurrent,
  onBuild,
  building = false,
  buildDisabled = false,
  buildDisabledReason = null
}: PreviewTabProps) {
  const [mode, setMode] = useState<PreviewMode>("orbit");

  return (
    // Everything below can throw — the WASM client, the worker seam,
    // three.js — and none of it may take the app down. Containing the whole
    // panel (not just the canvas) is what makes CLAUDE.md rule 6's "degrade
    // to the last server render" actually reachable.
    <PreviewErrorBoundary
      fallback={(message) => (
        <div className="preview-tab">
          <div className="live-status live-status--stale" role="status" data-testid="preview-crash-fallback">
            The interactive preview stopped working, so the last server render is shown instead.
            <span className="live-stderr"> {message}</span>
          </div>
          <Viewer3D stlUrl={stlUrl} />
          <ValidationPanel
            validation={validation}
            onBuild={onBuild}
            building={building}
            buildDisabled={buildDisabled}
            buildDisabledReason={buildDisabledReason}
          />
        </div>
      )}
    >
      <PreviewTabBody
        stlUrl={stlUrl}
        meshStatus={meshStatus}
        snapshotId={snapshotId}
        validation={validation}
        pngUrls={pngUrls}
        liveScad={liveScad}
        liveParams={liveParams}
        historical={historical}
        onReturnToCurrent={onReturnToCurrent}
        onBuild={onBuild}
        building={building}
        buildDisabled={buildDisabled}
        buildDisabledReason={buildDisabledReason}
        mode={mode}
        onModeChange={setMode}
      />
    </PreviewErrorBoundary>
  );
}

/**
 * The panel itself.
 *
 * Split from the exported component purely so the error boundary above is a
 * PARENT of the hook that can throw. A boundary never catches a throw from its
 * own render, so `useWasmPreview` had to move into a child.
 */
function PreviewTabBody({
  stlUrl,
  meshStatus,
  snapshotId,
  validation,
  pngUrls,
  liveScad,
  liveParams,
  historical,
  onReturnToCurrent,
  onBuild,
  building,
  buildDisabled,
  buildDisabledReason,
  mode,
  onModeChange
}: Required<Pick<PreviewTabProps, "stlUrl" | "meshStatus" | "snapshotId" | "validation" | "pngUrls" | "liveScad" | "liveParams">> & {
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  historical: boolean;
  onReturnToCurrent?: () => void;
  onBuild?: () => void;
  building: boolean;
  buildDisabled: boolean;
  buildDisabledReason: string | null;
}) {
  const isLive = mode === "live";
  const [showGrid, setShowGrid] = useState(true);
  const [measure, setMeasure] = useState(false);
  const [measureAxis, setMeasureAxis] = useState<MeasureFocus>("all");
  const [measuredBBox, setMeasuredBBox] = useState<BBox | null>(null);
  const [inspectEnabled, setInspectEnabled] = useState(false);
  const [inspectOutcome, setInspectOutcome] = useState<InspectionOutcome | null>(null);
  const inspectDisabled = mode !== "orbit" || stlUrl === null;

  // Nothing here relies on Viewer3D's own clearing (S2-4): a stlUrl/snapshotId
  // change covers a project switch or a History selection, a mode change
  // covers leaving 3D view, and turning the toggle off is explicit — all
  // independent of when (or whether) a new mesh finishes loading.
  useEffect(() => {
    setInspectOutcome(null);
  }, [stlUrl, snapshotId]);

  useEffect(() => {
    setInspectOutcome(null);
  }, [mode]);

  useEffect(() => {
    if (!inspectEnabled) setInspectOutcome(null);
  }, [inspectEnabled]);

  // `enabled: isLive` — the worker is only spawned while the Live tab is
  // actually selected, not on every project/param change.
  const wasm = useWasmPreview(liveScad, liveParams, isLive);
  const isStale = wasm.status !== "ok"; // AC: server-authority fallback + stale indicator, never blank

  const showPng = mode !== "orbit" && mode !== "live";
  const activePng = showPng ? (pngUrls[mode] ?? null) : null;

  /**
   * ONE mesh URL for ONE viewer.
   *
   * Previously `orbit` and `live` each rendered their own `<Viewer3D>` in
   * separate branches of a ternary, so every mode switch unmounted a
   * `<Canvas>` and mounted another. Browsers cap how many live WebGL contexts
   * a page may hold and reclaim the oldest, which showed up as
   * `THREE.WebGLRenderer: Context Lost` and a permanently blank viewport after
   * a few clicks — including in the plain 3D mode that had been working.
   *
   * Keeping a single canvas mounted for the life of the tab and swapping only
   * its URL avoids the churn entirely.
   */
  const viewerUrl = mode === "live" ? (isStale ? stlUrl : wasm.objectUrl) : stlUrl;
  const measuredSizes = measuredBBox ? bboxSize(measuredBBox) : null;

  return (
    <div className="preview-tab">
      {historical ? <div className="historical-banner" role="status">Viewing historical snapshot <button type="button" onClick={onReturnToCurrent}>Return to current</button></div> : null}
      <div className="preview-view-buttons" role="group" aria-label="Preview view">
        <button type="button" className={mode === "orbit" ? "active" : ""} onClick={() => onModeChange("orbit")}>
          3D
        </button>
        <button
          type="button"
          className={mode === "live" ? "active" : ""}
          onClick={() => onModeChange("live")}
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
            onClick={() => onModeChange(view)}
            data-testid={`view-button-${view}`}
          >
            {view}
          </button>
        ))}
        <span className="preview-view-spacer" />
        <button type="button" className={showGrid ? "active" : ""} onClick={() => setShowGrid((value) => !value)} aria-pressed={showGrid}>Grid</button>
        <button
          type="button"
          className={measure ? "active" : ""}
          onClick={() => setMeasure((value) => !value)}
          aria-pressed={measure}
          data-testid="measure-toggle"
        >
          Measure
        </button>
        <button
          type="button"
          className={inspectEnabled ? "active" : ""}
          onClick={() => setInspectEnabled((value) => !value)}
          aria-pressed={inspectEnabled}
          data-testid="inspect-toggle"
          disabled={inspectDisabled}
          title={inspectDisabled ? "Inspection uses the server render, available in 3D view." : undefined}
        >
          Inspect
        </button>
        <button type="button" onClick={() => onModeChange("orbit")}>Fit</button>
      </div>

      {measure ? (
        <div className="measure-controls" role="group" aria-label="Measurement axis">
          <span className="measure-controls-label">Face-to-face:</span>
          {(["all", ...AXES] as const).map((axis) => (
            <button
              key={axis}
              type="button"
              className={measureAxis === axis ? "active" : ""}
              onClick={() => setMeasureAxis(axis)}
              aria-pressed={measureAxis === axis}
              data-testid={`measure-axis-${axis}`}
            >
              {axis === "all" ? "All" : axis.toUpperCase()}
            </button>
          ))}
          <span className="measure-readout" data-testid="measure-readout">
            {measuredSizes ? (
              <>
                {AXES.map((axis) => `${axis.toUpperCase()} ${formatMm(measuredSizes[axis])} mm`).join(" · ")}{" "}
                <span className="measure-readout-source">(derived from preview mesh)</span>
              </>
            ) : (
              "No mesh to measure yet."
            )}
          </span>
        </div>
      ) : null}

      {mode === "live" ? (
        // Server-authority fallback (CLAUDE.md rule 6, binding): while the
        // WASM status is not `ok`, the viewer below keeps showing the last
        // SERVER-rendered mesh — never a blank canvas — with this indicator.
        <div
          className={`live-status live-status--${isStale ? "stale" : "live"}`}
          role="status"
          data-testid={isStale ? "live-stale-indicator" : "live-status"}
        >
          {LIVE_STATUS_LABEL[wasm.status]}
          {isStale && wasm.stderr ? <span className="live-stderr"> {wasm.stderr}</span> : null}
        </div>
      ) : null}

      <div className={`preview-surface ${showGrid ? "preview-surface--grid" : ""}`}>
        {/* Hidden rather than unmounted while a PNG is shown, so the WebGL
            context survives every mode switch (see `viewerUrl` above). */}
        <div className={showPng ? "preview-viewer preview-viewer--hidden" : "preview-viewer"}>
          <Viewer3D
            stlUrl={viewerUrl}
            emptyMessage={meshPlaceholderMessage(meshStatus, snapshotId)}
            measure={measure}
            measureAxis={measureAxis}
            onBoundingBox={setMeasuredBBox}
            inspect={inspectEnabled && mode === "orbit"}
            onInspect={setInspectOutcome}
          />
          {/* Issue #78 AC1/AC5: the empty-mesh placeholder above only ever
              explained the situation — this is the actual action that fixes
              it, laid over the same viewport rather than replacing
              `Viewer3D` (which must stay mounted for its single-canvas
              WebGL-context lifetime, see `viewerUrl` above). Only shown in
              orbit mode: `showPng` hides this whole wrapper for PNG views,
              and Live has its own status strip. */}
          {mode === "orbit" && onBuild && stlUrl === null && meshStatus === "absent" ? (
            <div className="preview-build-cta" data-testid="preview-build-cta">
              <button
                type="button"
                className="button button--primary"
                data-testid="preview-build-button"
                onClick={onBuild}
                disabled={buildDisabled}
                title={buildDisabledReason ?? undefined}
              >
                {building ? "Building…" : "Build"}
              </button>
            </div>
          ) : null}
        </div>
        {showPng ? (
          activePng ? (
            <img className="preview-png" src={activePng} alt={`${mode} view render`} />
          ) : (
            // Its own test id: the 3D viewer stays mounted (hidden) behind
            // this, so both placeholders are in the DOM at once and sharing
            // one id would make either impossible to select unambiguously.
            <div className="viewer-placeholder" data-testid="png-placeholder">
              No {mode} render yet.
            </div>
          )
        ) : null}
      </div>

      <InspectReadout outcome={inspectOutcome} snapshotId={snapshotId} />

      {/* Issue #41 symptom 3: the verdict belongs next to the thing it
          describes, not only as one coloured word in the status strip. */}
      <ValidationPanel
        validation={validation}
        onBuild={onBuild}
        building={building}
        buildDisabled={buildDisabled}
        buildDisabledReason={buildDisabledReason}
      />
    </div>
  );
}
