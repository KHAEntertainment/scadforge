// SPDX-License-Identifier: Apache-2.0
//
// No-Docker, no-API fixtures for the two seams and the SDK boundary. Exported
// from the package so `apps/server` and `packages/mcp-server` test their wiring
// against the same fixtures instead of each growing their own.

export {
  MockLibraryIndex,
  MockScadCore,
  greenGate,
  healthyReport,
  redGate,
  renderedView,
  snapshot,
  type MockScadCoreOptions
} from "./mock-scad-core.js";
export {
  createFakeSdk,
  type FakeResult,
  type FakeSdk,
  type FakeSdkOptions,
  type FakeTurn,
  type FakeUsage
} from "./fake-sdk.js";
