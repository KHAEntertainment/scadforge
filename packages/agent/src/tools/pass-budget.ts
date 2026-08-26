// SPDX-License-Identifier: Apache-2.0
//
// The per-turn self-correction budget (CLAUDE.md hard rule 4).
//
// Spike 3 §6 amendment 3 / `contract.ts` `PASS_BUDGET_ENFORCEMENT`: the counter
// lives in the TOOL layer, not in the provider. `maxTurns` counts API round
// trips, not build passes — a turn that renders twice is not a second pass —
// and keeping it here means `packages/mcp-server` inherits identical behaviour
// for free.

import { DEFAULT_MAX_PASSES, MAX_PASSES_ENV_VAR } from "./contract.js";

/** Why a `write_scad` call was refused. */
export type WriteRefusal =
  /** The pass budget is spent. */
  | "budget"
  /** The current code already validated green — CLAUDE.md rule 4's "stop early". */
  | "green";

/**
 * Read `SCADFORGE_MAX_PASSES` from an environment bag.
 *
 * Anything that is not a non-negative integer falls back to
 * {@link DEFAULT_MAX_PASSES} — a typo must not silently grant an unbounded
 * budget.
 */
export function resolveMaxPasses(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MAX_PASSES_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_PASSES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_PASSES;
  return parsed;
}

/** Options for {@link PassBudget}. */
export interface PassBudgetOptions {
  /** Defaults to {@link resolveMaxPasses}. */
  maxPasses?: number;
  /**
   * Refuse a further `write_scad` once the CURRENT code has validated green
   * (CLAUDE.md hard rule 4: "stop early when validation is green"). Default
   * true.
   */
  stopOnGreenValidation?: boolean;
}

/**
 * The turn's pass counter. One instance per turn; shared by the tool handlers
 * and read by the provider for event/usage bucketing.
 */
export class PassBudget {
  readonly maxPasses: number;
  readonly stopOnGreenValidation: boolean;

  /** 0 = the planning pass, before any `write_scad` was accepted. */
  private current = 0;
  /** The pass whose code most recently validated green; null when none has. */
  private greenAtPass: number | null = null;

  constructor(options: PassBudgetOptions = {}) {
    this.maxPasses = options.maxPasses ?? resolveMaxPasses();
    this.stopOnGreenValidation = options.stopOnGreenValidation ?? true;
  }

  /** The pass currently open. 0 before the first accepted `write_scad`. */
  get pass(): number {
    return this.current;
  }

  /** Writes still available. */
  get passesRemaining(): number {
    return Math.max(0, this.maxPasses - this.current);
  }

  /** True once every write has been spent. */
  get exhausted(): boolean {
    return this.current >= this.maxPasses;
  }

  /** True when the code produced by the current pass validated green. */
  get validatedGreen(): boolean {
    return this.greenAtPass !== null && this.greenAtPass === this.current;
  }

  /**
   * Why the next `write_scad` would be refused, or null when it is allowed.
   *
   * The green check only fires from pass 1 onward: refusing the very first
   * write of a turn because a *previous* turn left a green model would make the
   * agent unable to act at all.
   */
  refusalReason(): WriteRefusal | null {
    if (this.exhausted) return "budget";
    if (this.stopOnGreenValidation && this.current > 0 && this.validatedGreen) return "green";
    return null;
  }

  /** Accept a write and open the next pass. Returns the new pass number. */
  openPass(): number {
    this.current += 1;
    return this.current;
  }

  /** Record the outcome of a `validate_mesh` call against the current pass. */
  recordValidation(green: boolean): void {
    if (green) {
      this.greenAtPass = this.current;
    } else if (this.greenAtPass === this.current) {
      this.greenAtPass = null;
    }
  }
}
