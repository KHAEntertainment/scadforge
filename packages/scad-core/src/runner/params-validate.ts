// @scadforge/scad-core — validates a caller-supplied `ParamValues` partial
// bag against the live Customizer `ParamSchema` (Issue #32).
//
// THE single validation function both `apps/server/src/routes/params.ts`
// (via `services/scad-core-impl.ts`) and the agent's `set_params` tool (via
// `services/agent-scad-core.ts`) call — see `apps/server/src/services/
// runtime.ts`'s `planParamUpdate`, which wraps this together with the
// current-value merge so there is exactly ONE place that decides what a
// valid parameter update is. Never re-derive this check at a call site: a
// second implementation is exactly the class of divergence Issue #32 exists
// to prevent.
//
// Consumes the frozen `ParamSchema`/`ParamDefinition`/`ParamValue` shapes
// from `../types.ts` and reads `ParamDefinition.initial`'s shape (scalar vs.
// array) to decide whether a `"number"`-typed parameter expects a plain
// number or a numeric vector (`../params/literal.ts` surfaces an
// all-numeric vector as `type: "number"` with an array `initial` — see its
// header comment for the empirical citation). Does not import from
// `../params/**` (that package is a from-scratch reimplementation this
// package must not modify) — it only consumes the `ParamSchema` shape any
// caller already has in hand (from `runParamExport` or `parseParamSchema`).
//
// SPDX-License-Identifier: Apache-2.0

import type { ParamDefinition, ParamSchema, ParamValue, ParamValues } from "../types.js";

/** Why a supplied value was not applied. */
export type ParamRejectionReason = "unknown_param" | "wrong_type" | "out_of_range";

/** One value that failed validation and was therefore NOT merged into `accepted`. */
export interface ParamRejection {
  name: string;
  reason: ParamRejectionReason;
  /** Human-readable and actionable; safe to surface to the user or the model. */
  message: string;
}

export interface ValidateParamValuesResult {
  /** Values that passed validation, keyed by name. Callers merge this onto the current bag. */
  accepted: ParamValues;
  /** Empty when every supplied value validated. Order matches `Object.entries(values)`. */
  rejected: ParamRejection[];
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}

/**
 * `true` when every element of `value` is a finite number — the shape a
 * `"number"`-typed Customizer parameter's numeric-vector form takes (e.g.
 * `pos = [1, 2, 3];`, see `../params/literal.ts`).
 */
function isNumericVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

/** Checks `value`'s runtime type/shape against `def.type`, using `def.initial`'s shape to disambiguate scalar vs. vector `"number"` params. */
function checkType(def: ParamDefinition, value: ParamValue): string | null {
  switch (def.type) {
    case "boolean":
      return typeof value === "boolean" ? null : `'${def.name}' expects a boolean, got ${describeType(value)}.`;
    case "string":
      return typeof value === "string" ? null : `'${def.name}' expects a string, got ${describeType(value)}.`;
    case "vector":
      return Array.isArray(value) ? null : `'${def.name}' expects a vector, got ${describeType(value)}.`;
    case "number": {
      const expectsVector = Array.isArray(def.initial);
      if (expectsVector) {
        return isNumericVector(value)
          ? null
          : `'${def.name}' expects a numeric vector, got ${describeType(value)}.`;
      }
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `'${def.name}' expects a number, got ${describeType(value)}.`;
    }
  }
}

function paramValueEquals(a: ParamValue, b: ParamValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Checks `value` against `def`'s options/min/max/maxLength (type already confirmed by {@link checkType}). */
function checkRange(def: ParamDefinition, value: ParamValue): string | null {
  if (def.options && def.options.length > 0) {
    const isOption = def.options.some((option) => paramValueEquals(option.value, value));
    return isOption ? null : `'${def.name}' must be one of its declared options.`;
  }
  if (typeof value === "string" && def.maxLength !== undefined && value.length > def.maxLength) {
    return `'${def.name}' exceeds its max length of ${def.maxLength} (got ${value.length}).`;
  }
  const numbers: number[] =
    typeof value === "number" ? [value] : Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
  for (const n of numbers) {
    if (def.min !== undefined && n < def.min) return `'${def.name}' value ${n} is below its min of ${def.min}.`;
    if (def.max !== undefined && n > def.max) return `'${def.name}' value ${n} is above its max of ${def.max}.`;
  }
  return null;
}

/**
 * Validates `values` against `schema`, name by name.
 *
 * An EMPTY schema (`schema.parameters.length === 0`) means the current model
 * cannot be parsed for parameters yet (a brand-new project, or a source file
 * mid-edit) — every supplied value is accepted unvalidated rather than making
 * `set_params`/`PUT .../params` unusable before the first successful parse.
 * Once the schema is non-empty, EVERY name is checked: an unrecognized name
 * (including one that refers to a parameter the model no longer declares — a
 * stale `params.json` key, or a since-renamed variable) is rejected as
 * `"unknown_param"`, never silently dropped-but-unreported and never
 * silently coerced into range.
 */
export function validateParamValues(schema: ParamSchema, values: ParamValues): ValidateParamValuesResult {
  const accepted: ParamValues = {};
  const rejected: ParamRejection[] = [];

  if (schema.parameters.length === 0) {
    return { accepted: { ...values }, rejected };
  }

  const byName = new Map(schema.parameters.map((def) => [def.name, def] as const));
  for (const [name, value] of Object.entries(values)) {
    const def = byName.get(name);
    if (!def) {
      rejected.push({ name, reason: "unknown_param", message: `'${name}' is not a declared Customizer parameter.` });
      continue;
    }
    const typeError = checkType(def, value);
    if (typeError) {
      rejected.push({ name, reason: "wrong_type", message: typeError });
      continue;
    }
    const rangeError = checkRange(def, value);
    if (rangeError) {
      rejected.push({ name, reason: "out_of_range", message: rangeError });
      continue;
    }
    accepted[name] = value;
  }
  return { accepted, rejected };
}
