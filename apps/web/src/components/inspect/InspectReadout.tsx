import { formatMm } from "../measure.js";
import type { CylinderInspection, InspectionOutcome } from "./inspectionTypes.js";

/**
 * Deviation is reported right at the 0.01 mm recognition limit, where
 * `formatMm`'s one-decimal rounding would read "0 mm" — same 3-decimal
 * convention `refusals.ts` uses for the `not-circular` message's `{dev}`.
 */
function formatDeviationMm(value: number): string {
  return value.toFixed(3);
}

function surfaceLabel(surface: CylinderInspection["surface"]): string {
  return surface === "hole" ? "Hole" : "Outside";
}

function formatCenter(inspection: CylinderInspection): string {
  const { center } = inspection;
  return `(${formatMm(center.x)}, ${formatMm(center.y)}, ${formatMm(center.z)})`;
}

function provenanceLine(inspection: CylinderInspection, snapshotId: string | null): string {
  const source = snapshotId ? `Measured from snapshot ${snapshotId}` : "Measured from the current server render";
  const { evidence } = inspection;
  return `${source} · circle fit over ${formatMm(evidence.segments)} segments, ${formatMm(evidence.arcDegrees)}°, max deviation ${formatDeviationMm(evidence.maxDeviationMm)} mm`;
}

/**
 * The "Set up manually" CTA (D6): shown, disabled, next to every result —
 * refused or recognized — so the real layout is exercised now and S4 only
 * has to enable it. It never opens anything. `showEditableLabel` is true
 * only for a recognized result ("Editable: no binding" doesn't apply to a
 * refusal, which never had a binding slot to begin with).
 */
function SetupCta({ showEditableLabel }: { showEditableLabel: boolean }) {
  return (
    <>
      <div className="inspect-cta">
        {showEditableLabel ? <span>Editable: no binding</span> : null}
        <button type="button" disabled data-testid="inspect-setup-cta">
          Set up manually
        </button>
      </div>
      <div className="inspect-muted">Setup arrives with the editor.</div>
    </>
  );
}

export interface InspectReadoutProps {
  /** The latest outcome from `Viewer3D`'s `onInspect`; null means nothing is currently inspected. */
  outcome: InspectionOutcome | null;
  /** The snapshot the displayed mesh belongs to; null when inspecting the current, unsnapshotted server render. */
  snapshotId: string | null;
}

/**
 * S2 scope "Readout and interaction": what a click on Inspect measured,
 * from what, and why a surface was refused — never a guess (D6: fail
 * closed), never persisted (S2 produces tier-1 transient results only).
 * Renders nothing when there is no outcome to show.
 */
export function InspectReadout({ outcome, snapshotId }: InspectReadoutProps) {
  if (!outcome) return null;

  if (outcome.status === "refused") {
    return (
      <div className="inspect-readout" data-testid="inspect-readout" role="status">
        {/* D6: a refusal reason renders verbatim, as plain text -- never markdown or HTML. */}
        <div className="inspect-readout-message">{outcome.refusal.message}</div>
        <SetupCta showEditableLabel={false} />
      </div>
    );
  }

  const { inspection } = outcome;
  return (
    <div className="inspect-readout" data-testid="inspect-readout" role="status">
      <h4 className="inspect-readout-title">
        {surfaceLabel(inspection.surface)} · Ø {formatMm(inspection.diameterMm)} mm
      </h4>
      <div className="inspect-readout-detail">
        Axis {inspection.axis.toUpperCase()} · center {formatCenter(inspection)} · length {formatMm(inspection.evidence.axialLengthMm)} mm
      </div>
      <div className="inspect-muted">{provenanceLine(inspection, snapshotId)}</div>
      <SetupCta showEditableLabel={true} />
    </div>
  );
}
