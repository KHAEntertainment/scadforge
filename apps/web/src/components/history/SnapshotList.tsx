import type { SnapshotManifest, ValidationBadge } from "@scadforge/protocol";
import type { ApiClient } from "../../lib/apiClient.js";

const BADGE_LABEL: Record<ValidationBadge, string> = {
  green: "Valid",
  amber: "Warnings",
  red: "Invalid"
};

const MESSAGE_EXCERPT_LENGTH = 80;

/** Deterministic, locale-independent timestamp rendering (avoids CI/timezone flakiness). */
function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function excerpt(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return "(no message)";
  if (trimmed.length <= MESSAGE_EXCERPT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MESSAGE_EXCERPT_LENGTH).trimEnd()}…`;
}

export interface SnapshotListProps {
  client: ApiClient;
  snapshots: SnapshotManifest[];
  loading: boolean;
  error: string | null;
  /** The currently selected snapshot id, if any. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * SDP §9 History tab: snapshot list, newest first (per `ListSnapshotsResponse`
 * — this component does not re-sort), with an iso-view thumbnail, message
 * excerpt, timestamp, and validation badge per row (Issue #34 AC).
 */
export function SnapshotList({ client, snapshots, loading, error, selectedId, onSelect }: SnapshotListProps) {
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
        const thumbnail = snapshot.renders.find((r) => r.view === "iso") ?? null;
        const isSelected = snapshot.id === selectedId;
        return (
          <li key={snapshot.id}>
            <button
              type="button"
              className={`snapshot-row${isSelected ? " snapshot-row--selected" : ""}`}
              data-testid="snapshot-row"
              aria-pressed={isSelected}
              onClick={() => onSelect(snapshot.id)}
            >
              <span className="snapshot-thumb" data-testid="snapshot-thumb">
                {thumbnail ? (
                  <img src={client.resolveUrl(thumbnail.url)} alt={`Snapshot ${snapshot.id} iso view`} />
                ) : (
                  <span className="snapshot-thumb-placeholder" aria-hidden="true" />
                )}
              </span>
              <span className="snapshot-meta">
                <span
                  className={`validation-badge validation-badge--${badge ?? "unknown"}`}
                  data-testid="snapshot-badge"
                >
                  {badge ? BADGE_LABEL[badge] : "Not validated"}
                </span>
                <span className="snapshot-id">#{snapshot.id}</span>
                <span className="snapshot-origin">{snapshot.origin}</span>
                <span className="snapshot-message" data-testid="snapshot-message">
                  {excerpt(snapshot.message)}
                </span>
                <span className="snapshot-timestamp" data-testid="snapshot-timestamp">
                  {formatTimestamp(snapshot.timestamp)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
