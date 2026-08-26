import { useState } from "react";
import { ApiClientError, type ApiClient } from "../lib/apiClient.js";

export interface ExportButtonProps {
  client: ApiClient;
  projectId: string | null;
  onExported?: () => void;
}

type ExportState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "refused"; errorCode: string; message: string }
  | { status: "done" };

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** SDP §9 Exports: 3MF export, gated on validation; refusal surfaces the typed `{error_code}`. */
export function ExportButton({ client, projectId, onExported }: ExportButtonProps) {
  const [state, setState] = useState<ExportState>({ status: "idle" });

  async function handleExport(allowValidationFailure: boolean) {
    if (!projectId) return;
    setState({ status: "pending" });
    try {
      const result = await client.exportModel(projectId, {
        format: "3mf",
        allow_validation_failure: allowValidationFailure
      });
      const blob = await client.fetchExportFile(result.export.url);
      triggerDownload(blob, result.export.file);
      setState({ status: "done" });
      onExported?.();
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        setState({ status: "refused", errorCode: cause.error_code, message: cause.message });
      } else {
        setState({
          status: "refused",
          errorCode: "INTERNAL_ERROR",
          message: cause instanceof Error ? cause.message : "Export failed unexpectedly."
        });
      }
    }
  }

  const isGateRefusal = state.status === "refused" && state.errorCode === "VALIDATION_FAILED";

  return (
    <div className="export-button" data-testid="export-button">
      <button type="button" disabled={!projectId || state.status === "pending"} onClick={() => void handleExport(false)}>
        {state.status === "pending" ? "Exporting…" : "Export 3MF"}
      </button>

      {state.status === "refused" ? (
        <div className="export-refusal" role="alert" data-testid="export-refusal">
          <span className="export-error-code">{state.errorCode}</span>: {state.message}
          {isGateRefusal ? (
            <button
              type="button"
              className="export-override"
              onClick={() => void handleExport(true)}
              data-testid="export-override"
            >
              Export anyway
            </button>
          ) : null}
        </div>
      ) : null}

      {state.status === "done" ? <span className="export-success">Export downloaded.</span> : null}
    </div>
  );
}
