import { useState } from "react";
import type { SnapshotManifest } from "@scadforge/protocol";
import { ApiClientError, type ApiClient } from "../../lib/apiClient.js";

type RevertState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "pending" }
  | { status: "conflict"; message: string }
  | { status: "failed"; message: string }
  | { status: "done" };

export interface RevertButtonProps {
  client: ApiClient;
  projectId: string | null;
  /** The snapshot the button will revert to. */
  snapshotId: string | null;
  /** True when `snapshotId` is already the project's head (revert would be a no-op). */
  isHead: boolean;
  /** Called with the newly-created "revert" snapshot on success, so the caller can refresh + re-select. */
  onReverted: (snapshot: SnapshotManifest) => void;
}

/**
 * SDP §9 "Revert to this". History is append-only: a successful revert
 * creates a NEW snapshot carrying the target's content forward (Issue #34 AC)
 * — this component never claims to "restore" or "undo" in place. Under
 * concurrent writes the server surfaces the typed `CONFLICT` (409), which is
 * shown distinctly from a generic failure so the user knows a retry (not a
 * bug report) is the right next step.
 */
export function RevertButton({ client, projectId, snapshotId, isHead, onReverted }: RevertButtonProps) {
  const [state, setState] = useState<RevertState>({ status: "idle" });

  async function doRevert() {
    if (!projectId || !snapshotId) return;
    setState({ status: "pending" });
    try {
      const result = await client.revertSnapshot(projectId, snapshotId, {});
      setState({ status: "done" });
      onReverted(result.snapshot);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.error_code === "CONFLICT") {
        setState({
          status: "conflict",
          message: "Another change landed on this project just now. Refresh the history and try again."
        });
      } else {
        setState({
          status: "failed",
          message: cause instanceof Error ? cause.message : "Revert failed unexpectedly."
        });
      }
    }
  }

  const disabled = !projectId || !snapshotId || isHead || state.status === "pending";

  return (
    <div className="revert-button" data-testid="revert-button">
      {state.status === "confirming" ? (
        <div className="revert-confirm" data-testid="revert-confirm">
          <span>Create a new snapshot carrying #{snapshotId}'s content forward?</span>
          <button type="button" onClick={() => void doRevert()} data-testid="revert-confirm-yes">
            Yes, revert to this
          </button>
          <button type="button" onClick={() => setState({ status: "idle" })} data-testid="revert-confirm-no">
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setState({ status: "confirming" })}
          data-testid="revert-trigger"
        >
          {state.status === "pending" ? "Reverting…" : isHead ? "This is the current head" : "Revert to this"}
        </button>
      )}

      {state.status === "conflict" ? (
        <p className="revert-conflict" role="alert" data-testid="revert-conflict">
          {state.message}
          <button type="button" onClick={() => void doRevert()} data-testid="revert-retry">
            Retry
          </button>
        </p>
      ) : null}

      {state.status === "failed" ? (
        <p className="revert-failed" role="alert" data-testid="revert-failed">
          {state.message}
        </p>
      ) : null}

      {state.status === "done" ? (
        <p className="revert-success" data-testid="revert-success">
          Reverted — a new snapshot now carries this content forward.
        </p>
      ) : null}
    </div>
  );
}
