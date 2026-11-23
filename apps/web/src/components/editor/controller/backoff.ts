// SPDX-License-Identifier: Apache-2.0

// S3-C C2 — bounded exponential backoff for the `resolving` poll loop
// (spec §5 "Commit", AC: "bounded exponential backoff").
//
// Pure function so `controller.test.ts` can assert the exact schedule
// without depending on real timers, and so the resolving loop (R2: "MUST
// be abortable") can be driven deterministically under vitest fake timers.

export const RESOLVING_BASE_DELAY_MS = 500;
export const RESOLVING_MAX_DELAY_MS = 15_000;
export const RESOLVING_BACKOFF_FACTOR = 2;

/**
 * Delay before poll attempt `attempt` (1-indexed: the first poll after the
 * initial ambiguous commit response is `attempt === 1`). Doubles each
 * attempt, capped at {@link RESOLVING_MAX_DELAY_MS} so a long-running
 * ambiguity keeps polling at a steady, bounded interval rather than growing
 * unboundedly.
 */
export function resolvingBackoffDelayMs(attempt: number): number {
  if (attempt < 1) throw new RangeError(`attempt must be >= 1, got ${attempt}`);
  const raw = RESOLVING_BASE_DELAY_MS * RESOLVING_BACKOFF_FACTOR ** (attempt - 1);
  return Math.min(raw, RESOLVING_MAX_DELAY_MS);
}
