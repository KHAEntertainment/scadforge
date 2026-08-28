import { useMemo, useState } from "react";

/**
 * Diffs beyond this many lines are truncated by default, with an expand
 * affordance, so a very large diff can't freeze the tab (Issue #34 AC).
 * Chosen well above what a human reviews in one screenful but far below what
 * would make rendering (or the DOM) sluggish.
 */
export const DIFF_TRUNCATE_LINES = 500;

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line diff-line--file";
  if (line.startsWith("@@")) return "diff-line diff-line--hunk";
  if (line.startsWith("+")) return "diff-line diff-line--add";
  if (line.startsWith("-")) return "diff-line diff-line--del";
  return "diff-line diff-line--context";
}

export interface DiffViewProps {
  loading: boolean;
  error: string | null;
  /** Unified diff text, or `null` before a snapshot is selected. Empty string = no changes (first snapshot). */
  diff: string | null;
  /** The snapshot id this diff belongs to; used only to reset "expanded" on selection change. */
  snapshotId: string | null;
  parentId: string | null;
}

/**
 * SDP §9 History: side-by-side/unified diff for the selected snapshot vs its
 * parent. The frozen `SnapshotDiffResponse` contract returns `""` for the
 * first snapshot (no parent) — rendered as an explicit empty state, not a
 * blank pane.
 */
export function DiffView({ loading, error, diff, snapshotId, parentId }: DiffViewProps) {
  const [expanded, setExpanded] = useState(false);

  const lines = useMemo(() => (diff ? diff.split("\n") : []), [diff]);
  const isTruncated = !expanded && lines.length > DIFF_TRUNCATE_LINES;
  const visibleLines = isTruncated ? lines.slice(0, DIFF_TRUNCATE_LINES) : lines;

  if (!snapshotId) {
    return (
      <p className="diff-view-status" data-testid="diff-empty-selection">
        Select a snapshot to see its diff.
      </p>
    );
  }
  if (loading) {
    return <p className="diff-view-status">Loading diff…</p>;
  }
  if (error) {
    return (
      <p className="diff-view-status diff-view-status--error" role="alert">
        Couldn't load diff: {error}
      </p>
    );
  }
  if (diff === null) {
    return null;
  }
  if (parentId === null || diff.length === 0) {
    return (
      <p className="diff-view-status" data-testid="diff-first-snapshot">
        No changes to show — this is the first snapshot.
      </p>
    );
  }

  return (
    <div className="diff-view" data-testid="diff-view" key={snapshotId}>
      <pre className="diff-view-body">
        {visibleLines.map((line, idx) => (
          // Diff lines have no stable identity of their own; index is safe
          // here because the list is replaced wholesale, never reordered.
          <div key={idx} className={lineClass(line)}>
            {line.length === 0 ? " " : line}
          </div>
        ))}
      </pre>
      {isTruncated ? (
        <button type="button" className="diff-expand" data-testid="diff-expand" onClick={() => setExpanded(true)}>
          Show {lines.length - DIFF_TRUNCATE_LINES} more lines ({lines.length} total)
        </button>
      ) : null}
    </div>
  );
}
