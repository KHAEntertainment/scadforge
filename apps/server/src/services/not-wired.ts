// SPDX-License-Identifier: Apache-2.0
//
// PLACEHOLDER implementations of `ScadCoreApi` and `AgentProvider` so
// `apps/server` boots and serves `/api/health` on its own, before Issue #20
// wires in the real `packages/scad-core` (#14) and `packages/agent` (#16)
// implementations. Every method fails with a typed, well-formed error rather
// than throwing something unexpected — the process must never crash just
// because integration hasn't happened yet.
//
// Not used by any test — tests inject their own fakes (see
// `src/test/fakes.ts`) so route behavior is exercised, not this stub.

import { RouteError } from "./errors.js";
import type { ScadCoreApi } from "./scad-core-api.js";
import type { AgentProvider } from "./agent-provider.js";

const NOT_WIRED_MESSAGE =
  "scad-core is not wired into this server yet (see Issue #20: integration of #14/#16 with #17).";

function notWired(): never {
  throw new RouteError("INTERNAL_ERROR", NOT_WIRED_MESSAGE);
}

export const notWiredScadCoreApi: ScadCoreApi = {
  createProject: async () => notWired(),
  getProject: async () => notWired(),
  listProjects: async () => notWired(),
  listSnapshots: async () => notWired(),
  getSnapshot: async () => notWired(),
  getSnapshotDiff: async () => notWired(),
  revertSnapshot: async () => notWired(),
  getSnapshotRenderFile: async () => notWired(),
  renderViews: async () => notWired(),
  runExport: async () => notWired(),
  getExportFile: async () => notWired()
};

export const notWiredAgentProvider: AgentProvider = {
  runTurn: async () => {
    throw new RouteError("AGENT_ERROR", "The agent runtime is not wired into this server yet (see Issue #20).");
  }
};
