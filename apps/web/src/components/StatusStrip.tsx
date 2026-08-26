import { useEffect, useState } from "react";
import type { ValidationBadge } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

const BADGE_LABEL: Record<ValidationBadge, string> = {
  green: "Valid",
  amber: "Warnings",
  red: "Invalid"
};

export interface StatusStripProps {
  client: ApiClient;
  /** Latest validation state for the current head snapshot, if any. */
  validationBadge: ValidationBadge | null;
}

/** SDP §9: status strip with validation badge + pinned OpenSCAD version. */
export function StatusStrip({ client, validationBadge }: StatusStripProps) {
  const [openscadVersion, setOpenscadVersion] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .health()
      .then((health) => {
        if (!cancelled) setOpenscadVersion(health.openscad_version);
      })
      .catch((cause) => {
        if (!cancelled) setHealthError(cause instanceof Error ? cause.message : "Health check failed.");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div className="status-strip" role="status">
      <span
        className={`validation-badge validation-badge--${validationBadge ?? "unknown"}`}
        data-testid="validation-badge"
      >
        {validationBadge ? BADGE_LABEL[validationBadge] : "No render yet"}
      </span>
      <span className="openscad-version" data-testid="openscad-version">
        {healthError ? "OpenSCAD version unavailable" : (openscadVersion ?? "Checking OpenSCAD…")}
      </span>
    </div>
  );
}
