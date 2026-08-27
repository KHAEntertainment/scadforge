import { describe, expect, it } from "vitest";
import { ScadForgeError, withTypedError } from "./errors.js";

describe("ScadForgeError", () => {
  it("carries error_code and message, and serializes to a plain payload", () => {
    const err = new ScadForgeError("RENDER_FAILED", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.error_code).toBe("RENDER_FAILED");
    expect(err.message).toBe("boom");
    expect(err.toPayload()).toEqual({ error_code: "RENDER_FAILED", message: "boom" });
  });

  it("is() recognizes only real ScadForgeError instances", () => {
    expect(ScadForgeError.is(new ScadForgeError("TIMEOUT", "x"))).toBe(true);
    expect(ScadForgeError.is(new Error("plain"))).toBe(false);
    expect(ScadForgeError.is("not an error")).toBe(false);
    expect(ScadForgeError.is(null)).toBe(false);
    expect(ScadForgeError.is(undefined)).toBe(false);
  });

  describe("normalize", () => {
    it("passes an existing ScadForgeError through unchanged", () => {
      const original = new ScadForgeError("EXPORT_FAILED", "already typed");
      expect(ScadForgeError.normalize(original, "INTERNAL_ERROR")).toBe(original);
    });

    it("wraps a bare Error with the fallback code and a cause", () => {
      const cause = new Error("native failure");
      const wrapped = ScadForgeError.normalize(cause, "RENDER_FAILED");
      expect(wrapped.error_code).toBe("RENDER_FAILED");
      expect(wrapped.message).toBe("native failure");
      expect(wrapped.cause).toBe(cause);
    });

    it("prefixes a context message when given", () => {
      const wrapped = ScadForgeError.normalize(new Error("native failure"), "RENDER_FAILED", "render_views failed");
      expect(wrapped.message).toBe("render_views failed: native failure");
    });

    // COUNTEREXAMPLE: a non-Error thrown value (malicious/malformed callers).
    it("normalizes a thrown non-Error value (string, null, plain object)", () => {
      expect(ScadForgeError.normalize("plain string", "INTERNAL_ERROR").message).toBe("plain string");
      expect(ScadForgeError.normalize(null, "INTERNAL_ERROR").message).toBe("null");
      expect(ScadForgeError.normalize({ weird: true }, "INTERNAL_ERROR").message).toContain("object");
    });
  });

  describe("withTypedError", () => {
    it("returns the resolved value on success", async () => {
      await expect(withTypedError(async () => 42, "INTERNAL_ERROR")).resolves.toBe(42);
    });

    it("never lets a bare Error escape -- always a ScadForgeError", async () => {
      await expect(
        withTypedError(async () => {
          throw new Error("uncaught-looking failure");
        }, "RENDER_FAILED")
      ).rejects.toBeInstanceOf(ScadForgeError);
    });

    // COUNTEREXAMPLE: a thrown non-Error primitive must still normalize cleanly.
    it("normalizes a thrown non-Error value from inside the callback", async () => {
      await expect(
        withTypedError(async () => {
          throw "raw string throw";
        }, "INTERNAL_ERROR")
      ).rejects.toMatchObject({ error_code: "INTERNAL_ERROR", message: "raw string throw" });
    });
  });
});
