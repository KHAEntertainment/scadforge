// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  RESOLVING_BASE_DELAY_MS,
  RESOLVING_MAX_DELAY_MS,
  resolvingBackoffDelayMs
} from "./backoff.js";

describe("resolvingBackoffDelayMs", () => {
  it("starts at the base delay on the first attempt", () => {
    expect(resolvingBackoffDelayMs(1)).toBe(RESOLVING_BASE_DELAY_MS);
  });

  it("doubles each subsequent attempt", () => {
    expect(resolvingBackoffDelayMs(2)).toBe(RESOLVING_BASE_DELAY_MS * 2);
    expect(resolvingBackoffDelayMs(3)).toBe(RESOLVING_BASE_DELAY_MS * 4);
  });

  it("caps at the max delay for a long-running ambiguity", () => {
    expect(resolvingBackoffDelayMs(20)).toBe(RESOLVING_MAX_DELAY_MS);
  });

  it("rejects an attempt below 1", () => {
    expect(() => resolvingBackoffDelayMs(0)).toThrow(RangeError);
  });
});
