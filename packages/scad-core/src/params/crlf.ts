// @scadforge/scad-core — Customizer parameter parser: CRLF handling.
//
// Tech Lead / QA finding on PR #38: the real pinned OpenSCAD CLI's own
// Customizer comment parsing becomes unreliable when a `.scad` file uses
// CRLF line endings — confirmed empirically, but NOT as a simple "annotation
// on a CRLF-terminated line is always dropped" rule. Three probes against
// the real CLI, same trailing-annotation text (`// [10:80]`) on an
// otherwise-identical CRLF-terminated line, produced DIFFERENT results
// depending on unrelated PRECEDING content:
//   - as the very first line of the file: `min`/`max`/`step` dropped
//   - as the second declaration, right after another CRLF declaration:
//     `min`/`max`/`step` also dropped
//   - as the second line, right after a CRLF *comment-only* line: kept
//
// This is consistent with a lexer/tokenizer-level CRLF bug (the kind of
// flex-generated-lexer line-ending bug that is a known category — PROJECT
// CONTEXT's own history already has a second CRLF-class bug in PR #26's
// sanitizer), not a rule we can byte-model from the outside. A mixed-endings
// probe DID confirm one thing precisely: it is at least per-LINE, not
// whole-file (an LF-terminated declaration earlier in an otherwise-CRLF file
// kept its full annotation).
//
// Given a real upstream bug whose exact trigger is not fully characterizable
// from black-box probing, and the hard requirement that "parser and renderer
// must never disagree about what is parameterizable" (a slider must never be
// shown that the real CLI will silently ignore), this module takes the SAFE,
// CONSERVATIVE side of that uncertainty: if the source contains a CRLF line
// ending ANYWHERE, every parameter's annotation-derived fields (caption,
// min, max, step, maxLength, options) are stripped file-wide, keeping only
// name/type/initial/group (the fields that survived in every probe,
// including the CRLF ones). This may be MORE conservative than strictly
// necessary for some CRLF files (where the real CLI's own inconsistent
// behavior might have honored a given line's annotation) — that is the
// correct direction to err in: under-promising interactivity is safe,
// over-promising it (a dead slider) is not.
//
// The systemic fix — normalizing line endings to LF wherever scad-core
// writes/ingests `.scad` files (store/runner, outside this module's owned
// path) — is out of scope here and has been flagged back to the Tech Lead
// as a follow-up issue candidate. This module is the defensive backstop for
// files that still arrive with CRLF endings from elsewhere (user upload,
// external tooling, a pasted snippet).
//
// SPDX-License-Identifier: Apache-2.0

import type { ParamDefinition } from "../types.js";

/** True iff `source` contains at least one CRLF (`\r\n`) line ending. */
export function sourceHasCrlf(source: string): boolean {
  return source.includes("\r\n");
}

/** User-facing explanation for why a CRLF file's parameters lost their annotations. Stable text — safe to render verbatim in a UI. */
export const CRLF_ANNOTATION_WARNING =
  "This file uses CRLF (Windows-style) line endings. The OpenSCAD Customizer comment parser becomes unreliable under CRLF -- captions, ranges, dropdown options, and string length limits may silently not take effect in the renderer. ScadForge has stripped that annotation info from every parameter (name, type, default value, and group are still accurate) so the sliders shown here never promise more than the renderer will actually honor. Convert the file to LF line endings to restore full Customizer support.";

/** Strips every annotation-derived field, keeping only the fields that reliably survive CRLF in every observed case. */
export function stripAnnotationFields(def: ParamDefinition): ParamDefinition {
  const { name, type, initial, group } = def;
  const stripped: ParamDefinition = { name, type, initial, group };
  return stripped;
}
