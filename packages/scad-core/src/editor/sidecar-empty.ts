// @scadforge/scad-core — the canonical empty `EditorSidecar` constant, split
// out from `sidecar.ts` (S3-B ticket B4) so `store/transaction.ts` can
// reference it without an import cycle: `sidecar.ts` depends on
// `store/transaction.ts` for its staged writes, and `store/transaction.ts`
// needs this constant for its best-effort editor-revision computation when a
// transaction does not itself touch the sidecar. Re-exported verbatim from
// `sidecar.ts` so every existing import of `EMPTY_SIDECAR` from there
// (`sidecar.test.ts`, `store.test.ts`, `index.ts`) keeps working unchanged.
//
// SPDX-License-Identifier: Apache-2.0

import type { EditorSidecar } from "@scadforge/protocol";

/** The canonical empty sidecar — a NEW project's explicit starting state, and what a `legacy-empty` read reports. Never used as a placeholder for `missing`/`corrupt`/`unsupported-version` (see `sidecar.ts`'s header note). */
export const EMPTY_SIDECAR: EditorSidecar = { version: 1, features: [] };
