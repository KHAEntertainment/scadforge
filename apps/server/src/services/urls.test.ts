import { describe, expect, it } from "vitest";
import { API_BASE_PATH } from "@scadforge/protocol";
import { exportFileUrl, projectUrl, renderFileUrl, snapshotUrl } from "./urls.js";

describe("URL space (the host-owned side of the Issue #16 seam)", () => {
  it("builds render URLs that match the frozen route template", () => {
    expect(renderFileUrl("bracket", "0002", "iso")).toBe(`${API_BASE_PATH}/projects/bracket/snapshots/0002/views/iso`);
  });

  it("builds export URLs", () => {
    expect(exportFileUrl("bracket", "bracket-0002.3mf")).toBe(
      `${API_BASE_PATH}/projects/bracket/exports/bracket-0002.3mf`
    );
  });

  it("builds snapshot and project URLs", () => {
    expect(snapshotUrl("bracket", "0003")).toBe(`${API_BASE_PATH}/projects/bracket/snapshots/0003`);
    expect(projectUrl("bracket")).toBe(`${API_BASE_PATH}/projects/bracket`);
  });

  it("percent-encodes path segments so a stray character cannot break out of the path", () => {
    expect(exportFileUrl("bracket", "a b.3mf")).toBe(`${API_BASE_PATH}/projects/bracket/exports/a%20b.3mf`);
  });
});
