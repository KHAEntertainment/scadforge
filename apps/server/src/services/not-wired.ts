// SPDX-License-Identifier: Apache-2.0
//
// EXPLICITLY-UNAVAILABLE implementations of `ScadCoreApi` and `AgentProvider`.
//
// Issue #20 has wired the real implementations in (`services/scad-core-impl.ts`
// and `services/agent-impl.ts`, composed in `index.ts`), so nothing in the
// shipping server reaches these any more. They are kept — rather than deleted —
// because `createApp` is a pure DI function that must be constructible without
// Docker, without OpenSCAD and without model credentials: a harness that wants
// to exercise, say, the export routes with a real scad-core but no agent can
// pass `notWiredAgentProvider` and get a typed, well-formed refusal instead of
// a crash or a live API call.
//
// Not used by any route test — those inject their own fakes (`src/test/fakes.ts`)
// so route behavior is exercised, not this stub.

import { RouteError } from "./errors.js";
import type { ScadCoreApi } from "./scad-core-api.js";
import type { AgentProvider } from "./agent-provider.js";

const NOT_WIRED_MESSAGE = "This server instance was constructed without a scad-core implementation.";

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
  getSnapshotMeshFile: async () => notWired(),
  getParams: async () => notWired(),
  updateParams: async () => notWired(),
  getSource: async () => notWired(),
  preflightSource: async () => notWired(),
  updateSource: async () => notWired(),
  build: async () => notWired(),
  renderViews: async () => notWired(),
  runExport: async () => notWired(),
  getExportFile: async () => notWired()
};

export const notWiredAgentProvider: AgentProvider = {
  runTurn: async () => {
    throw new RouteError("AGENT_ERROR", "This server instance was constructed without an agent runtime.");
  }
};
