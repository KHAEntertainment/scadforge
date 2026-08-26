import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE_NAME } from "./index.js";

describe("@scadforge/agent placeholder", () => {
  it("exports a package name stub", () => {
    expect(AGENT_PACKAGE_NAME).toBe("@scadforge/agent");
  });
});
