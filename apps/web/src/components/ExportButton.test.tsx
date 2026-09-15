// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError, type ApiClient } from "../lib/apiClient.js";
import { ExportButton } from "./ExportButton.js";

function makeClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    baseUrl: "",
    health: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listSnapshots: vi.fn(),
    openChatStream: vi.fn(),
    exportModel: vi.fn(),
    fetchExportFile: vi.fn(),
    resolveUrl: vi.fn((path: string) => path),
    ...overrides
  } as ApiClient;
}

describe("ExportButton", () => {
  it("counterexample: surfaces a typed gate refusal without downloading anything", async () => {
    const exportModel = vi.fn().mockRejectedValue(new ApiClientError({ error_code: "VALIDATION_FAILED", message: "Mesh is not manifold." }));
    const fetchExportFile = vi.fn();
    const client = makeClient({ exportModel, fetchExportFile });

    render(<ExportButton client={client} projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: /export 3mf/i }));

    await waitFor(() => expect(screen.getByTestId("export-refusal")).toBeInTheDocument());
    expect(screen.getByTestId("export-refusal")).toHaveTextContent("VALIDATION_FAILED");
    expect(screen.getByTestId("export-refusal")).toHaveTextContent("Mesh is not manifold.");
    expect(fetchExportFile).not.toHaveBeenCalled();
    // The gate can be overridden explicitly.
    expect(screen.getByTestId("export-override")).toBeInTheDocument();
  });

  it("downloads the 3MF blob on success", async () => {
    const exportModel = vi.fn().mockResolvedValue({
      export: { snapshot: "0002", format: "3mf", file: "widget-0002.3mf", url: "/api/projects/p1/exports/widget-0002.3mf", bytes: 2048, timestamp: "2026-08-26T00:00:00.000Z", validation_overridden: false },
      validation: { badge: "green", manifold: true, components: 1, volume_mm3: 100, warning_count: 0 }
    });
    const fetchExportFile = vi.fn().mockResolvedValue(new Blob(["stub"]));
    const client = makeClient({ exportModel, fetchExportFile });

    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:stub");
    URL.revokeObjectURL = vi.fn();

    try {
      render(<ExportButton client={client} projectId="p1" />);
      await userEvent.click(screen.getByRole("button", { name: /export 3mf/i }));
      await waitFor(() => expect(screen.getByText(/export downloaded/i)).toBeInTheDocument());
      expect(fetchExportFile).toHaveBeenCalledWith("/api/projects/p1/exports/widget-0002.3mf");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
