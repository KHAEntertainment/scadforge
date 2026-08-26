// @scadforge/agent — package entry point.
//
// This package hosts the Claude Agent SDK integration behind a ModelProvider
// seam. `src/tools/contract.ts` is the FROZEN tool contract (Issue #13,
// Tech-Lead-owned — see its header); the runtime (provider/, prompts/, tool
// handlers, the 2-pass loop) arrives in Issue #16.
//
// SPDX-License-Identifier: Apache-2.0

export const AGENT_PACKAGE_NAME = "@scadforge/agent";

export * from "./tools/contract.js";
