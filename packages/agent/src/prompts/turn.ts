// SPDX-License-Identifier: Apache-2.0
//
// The per-turn user prompt.
//
// Spike 3 found that a turn against an EXISTING model must be told to inspect
// before it rewrites — otherwise the model regenerates from scratch and quietly
// discards the user's parameter values.

/** Options for {@link buildTurnPrompt}. */
export interface TurnPromptOptions {
  /** The user's message, verbatim. */
  message: string;
  /**
   * True when the project already has a `model.scad` worth reading. Defaults to
   * false (a fresh project).
   */
  hasExistingModel?: boolean;
}

/** Build the user-turn prompt handed to the provider. */
export function buildTurnPrompt(options: TurnPromptOptions): string {
  const message = options.message.trim();
  if (!message) throw new Error("buildTurnPrompt: message must not be empty");
  if (!options.hasExistingModel) return `Build this: ${message}`;
  return (
    `This project already has a model.scad. Request: ${message}\n\n` +
    "Call read_project first, then render_views and validate_mesh to see the CURRENT state. " +
    "Change only what the request needs and keep existing parameter names stable. " +
    "Do not rewrite the model blind."
  );
}
