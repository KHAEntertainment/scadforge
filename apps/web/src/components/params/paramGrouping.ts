// Pure reduction from the flat `ParamDefinitionWire[]` the params route
// returns into the sections the Params tab renders (Issue #33 AC: "grouped
// under `/* [Section] */` headings"). Kept independent of React so it can be
// unit-tested directly, mirroring `chatReducer.ts`'s "pure reducer,
// component-tested" convention for this repo.

import type { ParamDefinitionWire } from "@scadforge/protocol";

/** One `/* [Section] *\/` heading's worth of parameters, in schema order. */
export interface ParamGroup {
  /** `null` for parameters with no enclosing section — rendered ungrouped. */
  name: string | null;
  parameters: ParamDefinitionWire[];
}

/**
 * Groups parameters by their `group` field (the OpenSCAD `/* [Section] *\/`
 * heading), preserving:
 *   - first-seen group order (Customizer sections render top-to-bottom in the
 *     order they first appear in `model.scad`, not alphabetically), and
 *   - each group's original parameter order.
 *
 * Ungrouped parameters (`group: undefined`) form a single `name: null` bucket
 * emitted wherever its first member appeared — this is also what an EMPTY
 * schema reduces to: `[]` (the Params tab renders its own empty state on
 * `parameters.length === 0`, this function does not special-case it).
 */
export function groupParams(parameters: readonly ParamDefinitionWire[]): ParamGroup[] {
  const order: Array<string | null> = [];
  const buckets = new Map<string | null, ParamDefinitionWire[]>();

  for (const def of parameters) {
    const key = def.group ?? null;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(def);
  }

  return order.map((key) => ({ name: key, parameters: buckets.get(key) as ParamDefinitionWire[] }));
}
