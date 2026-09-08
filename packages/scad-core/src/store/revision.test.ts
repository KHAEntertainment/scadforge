// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { computeSourceRevision } from "./revision.js";

describe("computeSourceRevision (#54)", () => {
  const head = "0001";
  const scad = "cube(1);\n";
  const params = { size: 10 };

  it("is deterministic for identical input", () => {
    expect(computeSourceRevision(head, scad, params)).toBe(computeSourceRevision(head, scad, params));
  });

  it("changes when the head snapshot moves", () => {
    expect(computeSourceRevision("0002", scad, params)).not.toBe(computeSourceRevision(head, scad, params));
  });

  it("changes when the source is edited", () => {
    expect(computeSourceRevision(head, "cube(2);\n", params)).not.toBe(computeSourceRevision(head, scad, params));
  });

  it("changes when params change — including a snapshot:false write", () => {
    expect(computeSourceRevision(head, scad, { size: 11 })).not.toBe(computeSourceRevision(head, scad, params));
  });

  it("is insensitive to params key insertion order", () => {
    const a = computeSourceRevision(head, scad, { size: 10, offset: 3 });
    const b = computeSourceRevision(head, scad, { offset: 3, size: 10 });
    expect(a).toBe(b);
  });

  it("treats a null head distinctly from a real head", () => {
    expect(computeSourceRevision(null, scad, params)).not.toBe(computeSourceRevision(head, scad, params));
  });

  it("changes when an array param value changes", () => {
    expect(computeSourceRevision(head, scad, { pos: [1, 2, 3] })).not.toBe(
      computeSourceRevision(head, scad, { pos: [1, 2, 4] })
    );
  });
});
