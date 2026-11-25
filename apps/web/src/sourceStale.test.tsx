// SPDX-License-Identifier: Apache-2.0

import { useEffect, useLayoutEffect, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  clearSourceStaleIfCurrent,
  createSourceStaleMark,
  patchSourceStaleIfCurrent,
  type SourceStaleState
} from "./sourceStale.js";

function StaleOrderingHarness({
  initialMark,
  baseRevision,
  mode,
  queueBetweenCommitAndEffect
}: {
  initialMark: SourceStaleState;
  baseRevision: string;
  mode: "clear" | "patch";
  queueBetweenCommitAndEffect?: SourceStaleState;
}) {
  const [sourceStale, setSourceStale] = useState<SourceStaleState | null>(initialMark);

  // Runs synchronously after commit and before passive useEffect, reproducing a
  // second invalidation mark S2 queued in that React scheduling window.
  useLayoutEffect(() => {
    if (queueBetweenCommitAndEffect && sourceStale === initialMark) {
      setSourceStale(queueBetweenCommitAndEffect);
    }
  }, [queueBetweenCommitAndEffect, sourceStale, initialMark]);

  useEffect(() => {
    const stale = sourceStale;
    if (!stale) return;
    if (mode === "clear" && stale.freshRevision !== null && baseRevision === stale.freshRevision) {
      setSourceStale(clearSourceStaleIfCurrent(stale));
      return;
    }
    // Mirrors App.tsx: S1 was ready to request a re-read (`loading === false`), while
    // S2's later render sees `loading === true` and waits (so only S1's effect patches).
    const loading = stale !== initialMark;
    if (mode === "patch" && !loading && stale.requestedSeq === null) {
      setSourceStale(patchSourceStaleIfCurrent(stale, { requestedSeq: stale.sinceSeq }));
    }
  }, [sourceStale, baseRevision, mode, initialMark]);

  return <pre data-testid="stale-state">{JSON.stringify(sourceStale)}</pre>;
}

describe("sourceStale transition ordering (React commit -> passive effect window)", () => {
  it("preserves S2 when a second invalidation is queued between S1 fresh commit and S1 passive clear", () => {
    const s1: SourceStaleState = {
      ...createSourceStaleMark("p1", 1),
      freshRevision: "rev-1",
      requestedSeq: 1,
      settledSeq: 2
    };
    const s2 = createSourceStaleMark("p1", 2);

    render(
      <StaleOrderingHarness
        initialMark={s1}
        baseRevision="rev-1"
        mode="clear"
        queueBetweenCommitAndEffect={s2}
      />
    );

    const rendered = JSON.parse(screen.getByTestId("stale-state").textContent ?? "null");
    expect(rendered).toEqual(s2);
  });

  it("preserves S2 when a second invalidation is queued between S1 commit and S1 passive requestedSeq patch", () => {
    const s1 = createSourceStaleMark("p1", 1);
    const s2 = createSourceStaleMark("p1", 2);

    render(
      <StaleOrderingHarness
        initialMark={s1}
        baseRevision="rev-1"
        mode="patch"
        queueBetweenCommitAndEffect={s2}
      />
    );

    const rendered = JSON.parse(screen.getByTestId("stale-state").textContent ?? "null");
    expect(rendered).toEqual(s2);
  });

  it("clears or patches S1 normally when no newer mark superseded it", () => {
    const s1Fresh: SourceStaleState = {
      ...createSourceStaleMark("p1", 1),
      freshRevision: "rev-1",
      requestedSeq: 1,
      settledSeq: 2
    };
    const { rerender } = render(
      <StaleOrderingHarness initialMark={s1Fresh} baseRevision="rev-1" mode="clear" />
    );
    expect(JSON.parse(screen.getByTestId("stale-state").textContent ?? "null")).toBeNull();

    const s1Pending = createSourceStaleMark("p1", 5);
    act(() => {
      rerender(
        <StaleOrderingHarness key="patch" initialMark={s1Pending} baseRevision="rev-1" mode="patch" />
      );
    });
    expect(JSON.parse(screen.getByTestId("stale-state").textContent ?? "null")).toEqual({
      ...s1Pending,
      requestedSeq: 5
    });
  });
});
