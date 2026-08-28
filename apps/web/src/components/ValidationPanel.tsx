import type { ValidationSummary } from "@scadforge/protocol";

const BADGE_LABEL: Record<string, string> = {
  green: "Valid",
  amber: "Warnings",
  red: "Invalid"
};

/**
 * Turns a snapshot's `ValidationSummary` into the sentences a person needs.
 *
 * The warning STRINGS produced by scad-core's `gateValidation` are not
 * persisted anywhere — `validation.json` holds the raw `ValidationReport`, and
 * the manifest keeps only a `warning_count`. So the human-readable findings are
 * rebuilt here from the same facts the gate used. The wording is deliberately
 * plainer than the gate's: this is read by someone deciding whether to print
 * the part, not by the model.
 */
export function validationFindings(validation: ValidationSummary): string[] {
  const findings: string[] = [];

  if (!validation.manifold) {
    findings.push(
      "The mesh is not manifold (not a closed solid), so it is not printable as-is."
    );
    // Volume and component counts are meaningless on a non-manifold mesh —
    // scad-core's gate skips them for the same reason.
    return findings;
  }

  if (validation.components !== null && validation.components > 1) {
    // Issue #41 symptom 3, verbatim: the live-session model validated as 5
    // disconnected islands and the user was told nothing at all.
    findings.push(
      `This model is ${validation.components} separate pieces, not one connected solid. ` +
        "If you expected a single part, something is not joined to the rest."
    );
  }

  if (validation.volume_mm3 !== null && validation.volume_mm3 <= 0.001) {
    findings.push("The mesh encloses essentially no volume — the geometry is degenerate.");
  }

  // `warning_count` can exceed what is reconstructible above (nonzero genus,
  // for one, has no field in the summary). Rather than silently under-report,
  // say that more findings exist.
  if (findings.length < validation.warning_count) {
    const remaining = validation.warning_count - findings.length;
    findings.push(
      `${remaining} further finding${remaining === 1 ? "" : "s"} recorded in this snapshot's validation report.`
    );
  }

  return findings;
}

export interface ValidationPanelProps {
  /** The selected snapshot's validation summary; null when nothing has validated it. */
  validation: ValidationSummary | null;
}

/**
 * SDP §9 / CLAUDE.md rule 7: the validation verdict, stated where the user is
 * actually looking (Issue #41 symptom 3).
 *
 * A badge existed in the status strip, but it was a single coloured word with
 * no findings attached — an amber "Warnings" that never said what the warning
 * was. This panel sits under the preview and spells the verdict out.
 */
export function ValidationPanel({ validation }: ValidationPanelProps) {
  if (!validation) {
    return (
      <div className="validation-panel validation-panel--unknown" data-testid="validation-panel">
        <span className="validation-badge validation-badge--unknown" data-testid="validation-panel-badge">
          Not validated
        </span>
        <span className="validation-panel-detail">This snapshot has not been checked yet.</span>
      </div>
    );
  }

  const findings = validationFindings(validation);
  const label = BADGE_LABEL[validation.badge] ?? validation.badge;

  return (
    <div
      className={`validation-panel validation-panel--${validation.badge}`}
      data-testid="validation-panel"
      // `role="status"` (a polite live region) rather than `alert`: the verdict
      // updates whenever the previewed snapshot changes, and an assertive
      // region would interrupt a screen-reader user on every click in History.
      role="status"
    >
      <span
        className={`validation-badge validation-badge--${validation.badge}`}
        data-testid="validation-panel-badge"
      >
        {label}
      </span>
      {findings.length > 0 ? (
        <ul className="validation-findings" data-testid="validation-findings">
          {findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      ) : (
        <span className="validation-panel-detail">
          Manifold, single connected solid — no problems found.
        </span>
      )}
    </div>
  );
}
