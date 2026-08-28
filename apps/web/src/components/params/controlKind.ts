// Pure control-selection logic, split out of `ParamControl.tsx` so it can be
// unit-tested as a plain reduction from schema shape → control kind (Issue
// #33 AC: "component tests for control generation").

import type { ParamDefinitionWire } from "@scadforge/protocol";

export type ParamControlKind = "slider" | "number" | "checkbox" | "text" | "dropdown" | "unsupported";

/**
 * Chooses which control renders a given parameter definition:
 *   - a value list (`options`, from `// [a, b, c]`) always renders a dropdown,
 *     regardless of the underlying `type` — this matches OpenSCAD's own
 *     Customizer, which lets a `// [a, b, c]` list annotate a string, a
 *     number, or a boolean-typed variable.
 *   - a `number` with BOTH `min` and `max` (`// [min:max]` / `// [min:step:max]`)
 *     renders a slider; a `number` missing either bound (or missing both)
 *     renders a plain number input instead — the counterexample this project
 *     flagged explicitly ("a param with no min/max").
 *   - `boolean` → checkbox, `string` → text (respecting `maxLength`).
 *   - `vector` (no scalar OpenSCAD Customizer widget exists for it) with no
 *     `options` list is `"unsupported"` — the control shows the raw value
 *     read-only rather than fabricating an editor for it.
 */
export function controlKind(def: ParamDefinitionWire): ParamControlKind {
  if (def.options && def.options.length > 0) return "dropdown";
  switch (def.type) {
    case "boolean":
      return "checkbox";
    case "string":
      return "text";
    case "number":
      return def.min !== undefined && def.max !== undefined ? "slider" : "number";
    default:
      return "unsupported";
  }
}
