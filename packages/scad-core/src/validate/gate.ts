// @scadforge/scad-core — the pass/fail gate layered on top of a
// `ValidationReport`, per Spike 4's "Suggested thresholds" (frozen into
// `VALIDATION_GATE_DEFAULTS`/`ValidationGateResult` in ../types.ts).
//
// SPDX-License-Identifier: Apache-2.0

import { VALIDATION_GATE_DEFAULTS } from "../types.js";
import type { ValidationFailure, ValidationGateOptions, ValidationGateResult, ValidationReport } from "../types.js";

/**
 * Evaluates the frozen hard gates against a `ValidationReport`:
 * - `manifold === true` — hard (NOT_MANIFOLD).
 * - `volume_mm3 > minVolumeMm3` — hard, only meaningful once `manifold` is
 *   true (DEGENERATE_VOLUME).
 * - `components === 1` — hard by default, overridable via `allowMultiPart`
 *   (MULTIPLE_COMPONENTS).
 * `genus` is informational-only and never gates; it becomes a warning when
 * nonzero and `components === 1`.
 */
export function gateValidation(report: ValidationReport, options: ValidationGateOptions = {}): ValidationGateResult {
  const minVolumeMm3 = options.minVolumeMm3 ?? VALIDATION_GATE_DEFAULTS.minVolumeMm3;
  const allowMultiPart = options.allowMultiPart ?? VALIDATION_GATE_DEFAULTS.allowMultiPart;

  const failures: ValidationFailure[] = [];
  const warnings: string[] = [];

  if (!report.manifold) {
    failures.push({
      code: "NOT_MANIFOLD",
      message: `mesh is not manifold (status: ${report.status})`
    });
  } else {
    // Volume and component gates only make sense once we have a valid solid.
    if (report.volume_mm3 === null || report.volume_mm3 <= minVolumeMm3) {
      failures.push({
        code: "DEGENERATE_VOLUME",
        message: `mesh volume ${report.volume_mm3 ?? "null"} mm³ is at or below the minimum ${minVolumeMm3} mm³`
      });
    }

    if (report.components !== null && report.components !== 1) {
      if (allowMultiPart) {
        warnings.push(`mesh has ${report.components} disconnected solid components (multi-part allowed by override)`);
      } else {
        failures.push({
          code: "MULTIPLE_COMPONENTS",
          message: `mesh has ${report.components} disconnected solid components (expected 1; pass allowMultiPart to permit intentional multi-body exports)`
        });
      }
    }

    // Genus is informational only and only meaningful for a single component.
    if (report.components === 1 && report.genus !== null && report.genus !== 0) {
      warnings.push(`mesh has nonzero genus ${report.genus} (has holes/handles)`);
    }
  }

  const ok = failures.length === 0;
  const badge = !ok ? "red" : warnings.length > 0 ? "amber" : "green";

  return { ok, badge, failures, warnings };
}
