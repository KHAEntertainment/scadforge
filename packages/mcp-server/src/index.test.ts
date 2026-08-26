import { describe, expect, it } from "vitest";
import { MCP_SERVER_PACKAGE_NAME } from "./index.js";

describe("@scadforge/mcp-server placeholder", () => {
  it("exports a package name stub", () => {
    expect(MCP_SERVER_PACKAGE_NAME).toBe("@scadforge/mcp-server");
  });
});
