import { describe, expect, it } from "vitest";
import { LIBS_PACKAGE_NAME } from "./index.js";

describe("@scadforge/libs placeholder", () => {
  it("exports a package name stub", () => {
    expect(LIBS_PACKAGE_NAME).toBe("@scadforge/libs");
  });
});
