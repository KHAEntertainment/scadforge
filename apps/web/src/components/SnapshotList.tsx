import type { SnapshotManifest, ValidationBadge } from "@scadforge/protocol";

const BADGE_LABEL: Record<ValidationBadge, string> = {
  green: "Valid",
  amber: "Warnings",
  red: "Invalid"
};

export interface SnapshotListProps {
  snapshots: SnapshotManifest[];
  loading: boolean;
  error: string | null;
}

/** SDP §9 History: list of snapshots with a validation badge per entry. */
export function SnapshotList({ snapshots, loading, error }: SnapshotListProps) {
  if (loading) {
    return <p className="snapshot-list-status">Loading snapshots…</p>;
  }
  if (error) {
    return (
      <p className="snapshot-list-status snapshot-list-status--error" role="alert">
        Couldn't load snapshots: {error}
      </p>
    );
  }
  if (snapshots.length === 0) {
    return (
      <p className="snapshot-list-status" data-testid="snapshot-list-empty">
        No snapshots yet. Sending a message or saving from Code will create the first one.
      </p>
    );
  }

  return (
    <ul className="snapshot-list" data-testid="snapshot-list" aria-label="Snapshot history">
      {snapshots.map((snapshot) => {
        const badge = snapshot.validation?.badge ?? null;
        return (
          <li key={snapshot.id} className="snapshot-row" data-testid="snapshot-row">
            <span
              className={`validation-badge validation-badge--${badge ?? "unknown"}`}
              data-testid="snapshot-badge"
            >
              {badge ? BADGE_LABEL[badge] : "Not validated"}
            </span>
            <span className="snapshot-id">#{snapshot.id}</span>
            <span className="snapshot-origin">{snapshot.origin}</span>
            <span className="snapshot-message">{snapshot.message}</span>
          </li>
        );
      })}
    </ul>
  );
}
