// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PASSES, MAX_PASSES_ENV_VAR } from "./contract.js";
import { PassBudget, resolveMaxPasses } from "./pass-budget.js";

describe("resolveMaxPasses", () => {
  it("defaults to the frozen contract value", () => {
    expect(resolveMaxPasses({})).toBe(DEFAULT_MAX_PASSES);
    expect(DEFAULT_MAX_PASSES).toBe(2);
  });

  it("reads SCADFORGE_MAX_PASSES", () => {
    expect(resolveMaxPasses({ [MAX_PASSES_ENV_VAR]: "5" })).toBe(5);
    expect(resolveMaxPasses({ [MAX_PASSES_ENV_VAR]: "0" })).toBe(0);
  });

  it("falls back on garbage rather than granting an unbounded budget", () => {
    for (const raw of ["", "  ", "two", "-1", "1.5", "Infinity", "NaN"]) {
      expect(resolveMaxPasses({ [MAX_PASSES_ENV_VAR]: raw })).toBe(DEFAULT_MAX_PASSES);
    }
  });
});

describe("PassBudget", () => {
  it("starts on the planning pass with the full budget", () => {
    const budget = new PassBudget({ maxPasses: 2 });
    expect(budget.pass).toBe(0);
    expect(budget.passesRemaining).toBe(2);
    expect(budget.refusalReason()).toBeNull();
  });

  it("refuses once the budget is spent", () => {
    const budget = new PassBudget({ maxPasses: 2 });
    expect(budget.openPass()).toBe(1);
    expect(budget.openPass()).toBe(2);
    expect(budget.passesRemaining).toBe(0);
    expect(budget.exhausted).toBe(true);
    expect(budget.refusalReason()).toBe("budget");
  });

  it("refuses every write when maxPasses is 0", () => {
    expect(new PassBudget({ maxPasses: 0 }).refusalReason()).toBe("budget");
  });

  it("stops early once the CURRENT pass validated green", () => {
    const budget = new PassBudget({ maxPasses: 2 });
    budget.openPass();
    budget.recordValidation(true);
    expect(budget.validatedGreen).toBe(true);
    expect(budget.refusalReason()).toBe("green");
  });

  it("does not stop early on a red validation", () => {
    const budget = new PassBudget({ maxPasses: 2 });
    budget.openPass();
    budget.recordValidation(false);
    expect(budget.refusalReason()).toBeNull();
  });

  it("re-opens the budget when a later validation of the same pass goes red", () => {
    const budget = new PassBudget({ maxPasses: 3 });
    budget.openPass();
    budget.recordValidation(true);
    budget.recordValidation(false);
    expect(budget.refusalReason()).toBeNull();
  });

  it("never blocks the FIRST write because a previous turn left a green model", () => {
    const budget = new PassBudget({ maxPasses: 2 });
    budget.recordValidation(true); // recorded during the planning pass
    expect(budget.pass).toBe(0);
    expect(budget.refusalReason()).toBeNull();
  });

  it("honours stopOnGreenValidation: false", () => {
    const budget = new PassBudget({ maxPasses: 2, stopOnGreenValidation: false });
    budget.openPass();
    budget.recordValidation(true);
    expect(budget.refusalReason()).toBeNull();
  });
});
