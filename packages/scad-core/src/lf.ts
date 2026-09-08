// @scadforge/scad-core — systemic line-ending normalization (Issue #40).
//
// `params/crlf.ts` documents the observed failure mode: the pinned OpenSCAD
// CLI's Customizer comment parser becomes unreliable on CRLF-terminated source,
// so a CRLF file can surface sliders the renderer silently ignores. That
// module is the READ-time backstop (strip annotation fields on CRLF input that
// still arrives from elsewhere). THIS module is the WRITE-time fix: normalize
// every `.scad` source to LF-only line endings wherever scad-core ingests or
// persists source, so the store, the CLI runner, and the
// `--export-format=param` parser always see identical bytes and can never
// disagree about what is parameterizable.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Normalizes a `.scad` source to LF-only line endings. Handles `\r\n` (CRLF)
 * and any stray `\r` (classic-Mac) endings. Idempotent: an already-LF source
 * is returned unchanged.
 */
export function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
