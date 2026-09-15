// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — the React binding (spec §4.1 AC 8: "a `useSyncExternalStore`
// binding is provided"). Thin by design: it owns construction/disposal of
// one `TransactionController` per `(projectId, deps)` identity and exposes
// its live state; every actual transition stays in `controller.ts`.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { TransactionController } from "./controller.js";
import type { ControllerState, TransactionControllerDeps } from "./types.js";

export interface UseTransactionControllerResult {
  state: ControllerState;
  controller: TransactionController;
}

/**
 * One controller per `projectId` — switching projects tears down the old
 * controller (`dispose()`, which detaches any in-flight commit per R2) and
 * constructs a fresh one. `deps` fields other than `projectId` are read only
 * at construction time; the caller is expected to pass a referentially
 * stable `client`/`clock`/`timer`/`uuid`/`broadcastChannelFactory`.
 */
export function useTransactionController(deps: TransactionControllerDeps): UseTransactionControllerResult {
  // Intentionally keyed on `projectId` alone — see the doc comment above.
  const controller = useMemo(() => new TransactionController(deps), [deps.projectId]);

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  const state = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.state()
  );

  return { state, controller };
}
