// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — the React binding (spec §4.1 AC 8: "a `useSyncExternalStore`
// binding is provided"). Thin by design: it owns construction/disposal of
// one `TransactionController` per `(projectId, deps)` identity and exposes
// its live state; every actual transition stays in `controller.ts`.

import { useEffect, useState, useSyncExternalStore } from "react";
import { TransactionController } from "./controller.js";
import type { ControllerState, TransactionControllerDeps } from "./types.js";

export interface UseTransactionControllerResult {
  state: ControllerState;
  /** `null` until the mount effect has run (see the module doc comment on StrictMode below). */
  controller: TransactionController | null;
}

const IDLE_STATE: ControllerState = { kind: "idle" };

/**
 * One controller per `projectId` — switching projects tears down the old
 * controller (`dispose()`, which detaches any in-flight commit per R2) and
 * constructs a fresh one. `deps` fields other than `projectId` are read only
 * at construction time; the caller is expected to pass a referentially
 * stable `client`/`clock`/`timer`/`uuid`/`broadcastChannelFactory`.
 *
 * Construction lives in the EFFECT, not `useMemo` — the same pattern
 * `useStlGeometry.ts` uses for its own disposable resource. React 18
 * StrictMode's dev-mode double-invoke runs setup → cleanup → setup again,
 * synchronously, without re-rendering in between. A `useMemo`-built
 * controller with disposal only in the effect cleanup would be disposed by
 * the first (practice) cleanup and never rebuilt, since `useMemo` itself
 * isn't re-run — leaving `begin()` permanently refusing with `"not-idle"`
 * for the rest of the component's life. Building it in the effect means the
 * SECOND setup constructs a fresh, live instance, which is the one that
 * survives once the double-invoke settles.
 */
export function useTransactionController(deps: TransactionControllerDeps): UseTransactionControllerResult {
  const [controller, setController] = useState<TransactionController | null>(null);

  useEffect(() => {
    const instance = new TransactionController(deps);
    setController(instance);
    return () => instance.dispose();
    // Intentionally keyed on `projectId` alone — see the doc comment above.
  }, [deps.projectId]);

  const state = useSyncExternalStore(
    (listener) => (controller ? controller.subscribe(listener) : () => {}),
    () => (controller ? controller.state() : IDLE_STATE),
    () => IDLE_STATE
  );

  return { state, controller };
}
