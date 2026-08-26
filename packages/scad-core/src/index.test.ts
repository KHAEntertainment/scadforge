import { describe, expect, it } from "vitest";
import { SCAD_CORE_PACKAGE_NAME } from "./index.js";

describe("@scadforge/scad-core placeholder", () => {
  it("exports a package name stub", () => {
    expect(SCAD_CORE_PACKAGE_NAME).toBe("@scadforge/scad-core");
  });
});
