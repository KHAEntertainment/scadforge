// @scadforge/agent — package entry point.
//
// The Claude Agent SDK integration behind a `ModelProvider` seam.
// `src/tools/contract.ts` is the FROZEN tool contract (Issue #13,
// Tech-Lead-owned — see its header); everything else here is the Issue #16
// runtime: the provider, the system prompts, the tool handlers and the 2-pass
// loop.
//
// SPDX-License-Identifier: Apache-2.0

export const AGENT_PACKAGE_NAME = "@scadforge/agent";

// The frozen tool contract.
export * from "./tools/contract.js";

// Host-side enforcement of "no .scad in chat" (CLAUDE.md hard rule 5).
export {
  CODE_BLOCK_PLACEHOLDER,
  containsFencedCodeBlock,
  sanitizeChatText,
  stripFencedCodeBlocks,
  type StripFencedCodeBlocksOptions
} from "./sanitize.js";

// Prompts.
export {
  buildSystemPrompt,
  buildTurnPrompt,
  DEFAULT_SYSTEM_PROMPT,
  type SystemPromptOptions,
  type TurnPromptOptions
} from "./prompts/index.js";

// The CAD / library seams and the tool runtime.
export type {
  AgentExportRequest,
  AgentRenderRequest,
  AgentValidateRequest,
  LibraryIndexApi,
  ProjectState,
  ScadCoreApi,
  ScadCoreFailure,
  SetParamsOutcome,
  WriteScadOutcome,
  WriteScadRequest
} from "./tools/scad-core-api.js";
export { createToolHandlers, type ToolHandler, type ToolHandlerDeps, type ToolHandlerMap } from "./tools/handlers.js";
export {
  PassBudget,
  resolveMaxPasses,
  type PassBudgetOptions,
  type WriteRefusal
} from "./tools/pass-budget.js";
export { ToolActivityRecorder, type PassActivity, type ToolActivity } from "./tools/activity.js";
export {
  failureResult,
  filterStderr,
  imageBlock,
  imageLabelBlock,
  isErrorCode,
  jsonBlock,
  successResult,
  toErrorCode,
  toolResult
} from "./tools/results.js";

// The provider seam.
export * from "./provider/index.js";

// Turn orchestration.
export { runAgentTurn, type AgentTurnOutcome, type RunAgentTurnOptions } from "./loop.js";

// No-Docker fixtures, shared with `apps/server` and `packages/mcp-server`.
export * as testing from "./testing/index.js";
