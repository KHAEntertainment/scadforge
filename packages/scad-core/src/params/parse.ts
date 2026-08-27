// @scadforge/scad-core — Customizer parameter parser: orchestrator.
//
// Parses OpenSCAD Customizer comment syntax straight out of `.scad` SOURCE
// TEXT into the frozen `ParamSchema` (`../types.ts`, Tech-Lead-owned — not
// edited here). This is a from-scratch reimplementation of (a slice of)
// OpenSCAD's own Customizer comment grammar, grounded in empirical probes
// against the real pinned CLI (`--export-format=param`) rather than
// documentation, because the SDP/spike notes do not cover the grammar's
// corner cases. See `scan.ts` and `annotation.ts` for the specific rules and
// their empirical citations, and `cross-check.docker.test.ts` for the
// fixture-level proof this agrees with the real CLI (and the documented,
// deliberate divergences where it doesn't).
//
// Preferred acquisition path remains `runParamExport()` (SDP §7 — the real
// CLI is the source of truth at RUNTIME). This module exists for contexts
// where shelling out to the pinned container isn't available or desirable
// (fast static analysis, editor tooling, WASM-only environments) and must
// agree with the CLI closely enough to be a reliable stand-in.
//
// SPDX-License-Identifier: Apache-2.0

import type { ParamDefinition, ParamSchema } from "../types.js";
import { parsePrecedingCaption, parseTrailingAnnotation } from "./annotation.js";
import { scanTopLevel } from "./scan.js";
import type { ScanEvent } from "./scan.js";

/** The default Customizer group/tab name the real CLI assigns when no `/* [Section] *\/` header precedes a parameter. */
export const DEFAULT_PARAM_GROUP = "Parameters";

export interface ParseParamSchemaOptions {
  /** `ParamSchema.title` — OpenSCAD emits the model file's stem here; the parser has no filename of its own to derive one from. Defaults to `""`. */
  title?: string;
}

function buildParamDefinition(
  event: Extract<ScanEvent, { kind: "decl" }>,
  group: string,
  pendingCaption: string | undefined
): ParamDefinition {
  const annotation =
    event.trailingComment != null ? parseTrailingAnnotation(event.trailingComment, event.literal) : {};
  const caption = annotation.caption ?? (pendingCaption !== undefined ? parsePrecedingCaption(pendingCaption) : undefined);

  const def: ParamDefinition = {
    name: event.name,
    type: event.literal.type,
    initial: event.literal.value,
    group
  };
  if (caption !== undefined && caption.length > 0) def.caption = caption;
  if (annotation.min !== undefined) def.min = annotation.min;
  if (annotation.max !== undefined) def.max = annotation.max;
  if (annotation.step !== undefined) def.step = annotation.step;
  if (annotation.maxLength !== undefined) def.maxLength = annotation.maxLength;
  if (annotation.options !== undefined) def.options = annotation.options;
  return def;
}

/**
 * Parses Customizer-annotated OpenSCAD source text into a {@link ParamSchema}.
 * Never throws — any malformed/truncated/adversarial input degrades to
 * "fewer parameters recognized, or a parameter surfaced with less
 * annotation than intended", never an exception (see `annotation.ts`/
 * `scan.ts` for the specific fallbacks, and `fuzz.test.ts` for the property
 * test proving this over the vendored BOSL2/MCAD corpus).
 */
export function parseParamSchema(source: string, options?: ParseParamSchemaOptions): ParamSchema {
  const events = scanTopLevel(source);
  const parameters: ParamDefinition[] = [];
  let currentGroup = DEFAULT_PARAM_GROUP;
  let pendingCaption: string | undefined;

  for (const event of events) {
    switch (event.kind) {
      case "group":
        currentGroup = event.name;
        pendingCaption = undefined;
        break;
      case "caption":
        pendingCaption = event.text;
        break;
      case "decl":
        parameters.push(buildParamDefinition(event, currentGroup, pendingCaption));
        pendingCaption = undefined;
        break;
      case "skip":
        pendingCaption = undefined;
        break;
      case "stop":
        break;
    }
  }

  return { title: options?.title ?? "", parameters };
}
