// @scadforge/scad-core — which current parameter overrides survive a source
// edit (Issue #54).
//
// When the user edits the `.scad` source, some of the current `params.json`
// overrides may stop being valid: the variable they name may have been removed
// or renamed, or the source may have tightened its type/range/options so the
// existing value no longer fits. The studio must surface EXACTLY which
// overrides a save would drop, and the save must require an explicit
// acknowledgement of each one. This module is the single, pure rule for that
// split — it reuses `validateParamValues` (Issue #32) so a "retained" override
// here is precisely a value the `set_params`/`PUT .../params` path would also
// accept, and a "removed" override is one of that path's rejections.
//
// SPDX-License-Identifier: Apache-2.0

import type { RemovedParam } from "@scadforge/protocol";
import type { ParamSchema, ParamValues } from "../types.js";
import { validateParamValues } from "./params-validate.js";

/** The outcome of applying a proposed source edit to the current params. */
export interface SourceParamsAnalysis {
  /** Current overrides that survive the proposed source unchanged. */
  retained_params: ParamValues;
  /** Current overrides the proposed source would drop, each with a reason. */
  removed_params: RemovedParam[];
}

/**
 * Splits `currentParams` into the overrides a source edit to `schema` retains
 * vs. drops. `syntaxOk: false` means the proposed source does not parse, so no
 * split can be computed — everything is conservatively empty (the caller
 * should gate on the syntax check first). A VALID source that declares zero
 * parameters drops every current override ("no longer declared").
 */
export function analyzeSourceParams(
  schema: ParamSchema,
  currentParams: ParamValues,
  syntaxOk: boolean
): SourceParamsAnalysis {
  if (!syntaxOk) return { retained_params: {}, removed_params: [] };

  if (schema.parameters.length === 0) {
    const removed_params: RemovedParam[] = Object.keys(currentParams).map((name) => ({
      name,
      reason: `'${name}' is no longer declared in the source.`
    }));
    return { retained_params: {}, removed_params };
  }

  // validateParamValues' empty-schema "accept everything" behavior (Issue #32)
  // is the wrong rule here — an empty schema on a VALID source means the
  // source declares nothing, so every current override is dropped (handled
  // above). With a non-empty schema it gives the exact accepted/rejected split
  // we want: unknown name, wrong type, or out-of-range/not-an-option.
  const result = validateParamValues(schema, currentParams);
  return {
    retained_params: result.accepted,
    removed_params: result.rejected.map((r) => ({ name: r.name, reason: r.message }))
  };
}
