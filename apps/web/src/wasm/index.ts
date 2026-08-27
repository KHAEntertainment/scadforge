// GPL ZONE — Issue #31.
//
// Public facade for `apps/web/src/wasm/**`. Code outside this directory
// (PreviewTab, App) should import ONLY from here, not from the worker/client
// internals directly — keeps the GPL zone boundary a single reviewable seam.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export { useWasmPreview } from "./useWasmPreview.js";
export type { UseWasmPreviewResult } from "./useWasmPreview.js";
export type { WasmPreviewStatus } from "./wasmPreviewClient.js";
