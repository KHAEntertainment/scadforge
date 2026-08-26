import { describe, expect, it } from "vitest";
import { PROTOCOL_PACKAGE_NAME } from "./index.js";

describe("@scadforge/protocol placeholder", () => {
  it("exports a package name stub", () => {
    expect(PROTOCOL_PACKAGE_NAME).toBe("@scadforge/protocol");
  });
});
