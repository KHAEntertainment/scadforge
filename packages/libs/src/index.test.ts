import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LIBS_PACKAGE_NAME,
  LibraryLookupError,
  bosl2Path,
  libraryIndexStats,
  libraryPath,
  loadIndexFromPath,
  lookup,
  mcadPath
} from "./index.js";

describe("@scadforge/libs package identity", () => {
  it("exports the package name", () => {
    expect(LIBS_PACKAGE_NAME).toBe("@scadforge/libs");
  });
});

describe("bosl2Path() / mcadPath()", () => {
  it("point at real, on-disk vendored checkouts carrying their own LICENSE", () => {
    expect(existsSync(bosl2Path())).toBe(true);
    expect(existsSync(join(bosl2Path(), "LICENSE"))).toBe(true);
    expect(existsSync(join(bosl2Path(), "screws.scad"))).toBe(true);

    expect(existsSync(mcadPath())).toBe(true);
    expect(existsSync(join(mcadPath(), "LICENSE"))).toBe(true);
    expect(existsSync(join(mcadPath(), "involute_gears.scad"))).toBe(true);
  });

  it("libraryPath() dispatches to the same paths by LibraryName", () => {
    expect(libraryPath("BOSL2")).toBe(bosl2Path());
    expect(libraryPath("MCAD")).toBe(mcadPath());
  });
});

describe("libraryIndexStats() — committed-index regression guard", () => {
  it("matches the pinned symbol counts (update deliberately if the vendored pins move)", () => {
    const stats = libraryIndexStats();
    expect(stats.BOSL2).toBe(972);
    expect(stats.MCAD).toBe(203);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ≥10 representative queries (AC 3).
// ─────────────────────────────────────────────────────────────────────────

describe("lookup() — representative queries", () => {
  it("'BOSL2 screw_hole' surfaces screw_hole() from BOSL2 first", () => {
    const matches = lookup("BOSL2 screw_hole");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toMatchObject({ library: "BOSL2", name: "screw_hole", kind: "module" });
  });

  it("'rounded cuboid' surfaces cuboid()", () => {
    const matches = lookup("rounded cuboid");
    expect(matches.some((m) => m.name === "cuboid" && m.library === "BOSL2")).toBe(true);
  });

  it("'threaded rod' surfaces threaded_rod()", () => {
    const matches = lookup("threaded rod");
    expect(matches[0]).toMatchObject({ library: "BOSL2", name: "threaded_rod" });
  });

  it("'spur gear' surfaces spur_gear()", () => {
    const matches = lookup("spur gear");
    expect(matches[0]).toMatchObject({ library: "BOSL2", name: "spur_gear" });
  });

  it("'attach children to a parent' surfaces attach()", () => {
    const matches = lookup("attach children to a parent");
    expect(matches[0]).toMatchObject({ library: "BOSL2", name: "attach" });
  });

  it("'position anchor point' surfaces position()", () => {
    const matches = lookup("position anchor point");
    expect(matches[0]).toMatchObject({ library: "BOSL2", name: "position", kind: "module" });
  });

  it("'nut trap' surfaces a BOSL2 nut_trap_* module", () => {
    const matches = lookup("nut trap");
    expect(matches.some((m) => m.library === "BOSL2" && m.name.startsWith("nut_trap"))).toBe(true);
  });

  it("'$slop tolerance' surfaces the $slop constant", () => {
    const matches = lookup("$slop tolerance");
    expect(matches.some((m) => m.name === "$slop" && m.kind === "constant")).toBe(true);
  });

  it("'MCAD involute gear tooth' surfaces involute_gear_tooth() from MCAD", () => {
    const matches = lookup("MCAD involute gear tooth");
    expect(matches.some((m) => m.library === "MCAD" && m.name === "involute_gear_tooth")).toBe(true);
  });

  it("'MCAD bearing' surfaces a bearing-related MCAD symbol", () => {
    const matches = lookup("MCAD bearing", { library: "MCAD" });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.library === "MCAD")).toBe(true);
    expect(matches.some((m) => m.name.toLowerCase().includes("bearing"))).toBe(true);
  });

  it("library filter restricts results to that library only", () => {
    const matches = lookup("gear", { library: "MCAD" });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.library === "MCAD")).toBe(true);
  });

  it("result entries carry every LibrarySymbol field the frozen contract requires", () => {
    const [match] = lookup("cuboid");
    expect(match).toMatchObject({
      library: expect.any(String),
      name: expect.any(String),
      kind: expect.stringMatching(/^(module|function|constant)$/),
      signature: expect.any(String),
      file: expect.any(String),
      summary: expect.any(String),
      include: expect.any(String)
    });
    expect(Array.isArray(match.examples)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Counterexamples (mandatory self-check, Step 4).
// ─────────────────────────────────────────────────────────────────────────

describe("lookup() — counterexamples", () => {
  it("throws a typed INVALID_QUERY error on an empty query", () => {
    expect(() => lookup("")).toThrow(LibraryLookupError);
    try {
      lookup("");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LibraryLookupError);
      expect((err as LibraryLookupError).code).toBe("INVALID_QUERY");
    }
  });

  it("throws a typed INVALID_QUERY error on a whitespace-only query", () => {
    expect(() => lookup("   \t\n  ")).toThrow(LibraryLookupError);
  });

  it("returns an empty array (not an error) for a query with no match", () => {
    // A single gibberish token (no spaces/underscores to split, and not a
    // substring of any real symbol name, summary, or signature) rather than
    // a sentence of common English words — several BOSL2 modifier helpers
    // are literally named `*_this` (`hide_this`, `color_this`, ...), so an
    // English no-match query can accidentally match on a real word.
    const matches = lookup("qzxjklnonexistentsymbol987654");
    expect(matches).toEqual([]);
  });

  it("handles a huge query string without throwing, still respecting limit", () => {
    const huge = "cuboid ".repeat(5000); // ~35,000 chars
    const matches = lookup(huge, { limit: 3 });
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it("clamps an over-cap limit to 50", () => {
    const matches = lookup("BOSL2", { limit: 5000 });
    expect(matches.length).toBeLessThanOrEqual(50);
  });

  it("clamps a zero/negative limit up to at least 1", () => {
    const matches = lookup("cuboid", { limit: 0 });
    expect(matches.length).toBe(1);
  });

  it("throws a typed INDEX_MISSING error when the index file is absent", () => {
    const missingPath = join(tmpdir(), `scadforge-libs-missing-${Date.now()}.json`);
    expect(() => loadIndexFromPath(missingPath)).toThrow(LibraryLookupError);
    try {
      loadIndexFromPath(missingPath);
      expect.unreachable();
    } catch (err) {
      expect((err as LibraryLookupError).code).toBe("INDEX_MISSING");
    }
  });

  describe("throws a typed INDEX_INVALID error for a malformed index file", () => {
    const dir = mkdtempSync(join(tmpdir(), "scadforge-libs-invalid-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("on non-JSON content", () => {
      const path = join(dir, "not-json.json");
      writeFileSync(path, "{ this is not json", "utf-8");
      try {
        loadIndexFromPath(path);
        expect.unreachable();
      } catch (err) {
        expect((err as LibraryLookupError).code).toBe("INDEX_INVALID");
      }
    });

    it("on valid JSON that isn't an array", () => {
      const path = join(dir, "wrong-shape.json");
      writeFileSync(path, JSON.stringify({ not: "an array" }), "utf-8");
      try {
        loadIndexFromPath(path);
        expect.unreachable();
      } catch (err) {
        expect((err as LibraryLookupError).code).toBe("INDEX_INVALID");
      }
    });
  });
});
