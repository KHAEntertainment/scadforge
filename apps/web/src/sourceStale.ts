// SPDX-License-Identifier: Apache-2.0

export interface SourceStaleState {
  projectId: string;
  /** The source request sequence at the receipt: only later requests count. */
  sinceSeq: number;
  /** The revision of the latest-started post-receipt read/write that succeeded. */
  freshRevision: string | null;
  /** The latest-started post-receipt read failed; Build retries it. */
  failed: boolean;
  /** The sequence when the last re-read was requested (`null`: none yet). */
  requestedSeq: number | null;
  /** The latest-started post-receipt request that settled. */
  settledSeq: number;
}

export function createSourceStaleMark(projectId: string, sinceSeq: number): SourceStaleState {
  return {
    projectId,
    sinceSeq,
    freshRevision: null,
    failed: false,
    requestedSeq: null,
    settledSeq: 0
  };
}

/**
 * Guarded clear: clears `sourceStale` only if no newer invalidation mark has
 * replaced `captured` since the render that scheduled the effect.
 */
export function clearSourceStaleIfCurrent(
  captured: SourceStaleState
): (prev: SourceStaleState | null) => SourceStaleState | null {
  return (prev) => (prev === captured ? null : prev);
}

/**
 * Guarded patch: updates `sourceStale` only if no newer invalidation mark has
 * replaced `captured` since the render that scheduled the effect or handler.
 */
export function patchSourceStaleIfCurrent(
  captured: SourceStaleState,
  patch: Partial<Pick<SourceStaleState, "failed" | "requestedSeq">>
): (prev: SourceStaleState | null) => SourceStaleState | null {
  return (prev) => (prev === captured ? { ...prev, ...patch } : prev);
}
