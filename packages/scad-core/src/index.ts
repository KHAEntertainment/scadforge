// @scadforge/scad-core — package entry point.
//
// This package owns the OpenSCAD project model. `src/types.ts` is the FROZEN
// contract (Issue #13, Tech-Lead-owned — see its header); the runtime lives in
// params/ (Customizer parameter parsing), store/ (filesystem `.scadforge/`
// project store), validate/ (mesh validation) and runner/ (OpenSCAD CLI
// subprocess runner), and arrives in Issue #14.
//
// SPDX-License-Identifier: Apache-2.0

export const SCAD_CORE_PACKAGE_NAME = "@scadforge/scad-core";

export * from "./types.js";
