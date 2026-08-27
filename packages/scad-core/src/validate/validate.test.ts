// Exercises validateMesh end-to-end against manifold-3d (pure JS/WASM --
// no Docker/OpenSCAD needed). Mesh fixtures are synthetic binary STL buffers
// built by test-support/stl-fixtures.ts, mirroring Spike 4's good/bad/
// multi-island cases.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScadForgeError } from "../errors.js";
import { buildBinaryStl, cubeTriangles, openCubeTriangles, translateTriangles } from "../test-support/stl-fixtures.js";
import { validateMesh } from "./validate.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "scadcore-validate-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeMesh(name: string, buf: Buffer): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, buf);
  return path;
}

describe("validateMesh", () => {
  it("a good 20mm cube is manifold with the expected geometric measurements", async () => {
    const meshPath = await writeMesh("good.stl", buildBinaryStl(cubeTriangles(20)));
    const result = await validateMesh({ meshPath });
    expect(result.report).toEqual({
      manifold: true,
      status: "NoError",
      volume_mm3: 8000,
      surface_area: 2400,
      bbox: { min: [0, 0, 0], max: [20, 20, 20] },
      triangle_count: 12,
      components: 1,
      genus: 0
    });
    expect(result.gate).toEqual({ ok: true, badge: "green", failures: [], warnings: [] });
    expect(result.validate_ms).toBeGreaterThanOrEqual(0);
    expect(result.export_ms).toBeNull();
  });

  it("an open (non-watertight) mesh reports manifold:false, status:'ConstructionFailed', and still reports triangle_count", async () => {
    const meshPath = await writeMesh("bad-mesh.stl", buildBinaryStl(openCubeTriangles(20)));
    const result = await validateMesh({ meshPath });
    expect(result.report.manifold).toBe(false);
    expect(result.report.status).toBe("ConstructionFailed");
    expect(result.report.triangle_count).toBe(10);
    expect(result.report.volume_mm3).toBeNull();
    expect(result.report.components).toBeNull();
    expect(result.gate.ok).toBe(false);
    expect(result.gate.failures[0].code).toBe("NOT_MANIFOLD");
  });

  it("two disconnected islands report components:2 and the Euler-artifact genus (1-k)", async () => {
    const island1 = cubeTriangles(10);
    const island2 = translateTriangles(cubeTriangles(10), 30, 0, 0);
    const meshPath = await writeMesh("multi-island.stl", buildBinaryStl([...island1, ...island2]));
    const result = await validateMesh({ meshPath });
    expect(result.report.manifold).toBe(true);
    expect(result.report.components).toBe(2);
    expect(result.report.volume_mm3).toBe(2000);
    expect(result.report.genus).toBe(-1); // 1 - k, only meaningful at components===1
    expect(result.gate.ok).toBe(false); // MULTIPLE_COMPONENTS, default gate
    expect(result.gate.failures[0].code).toBe("MULTIPLE_COMPONENTS");
  });

  it("multi-island passes the gate (as a warning) when allowMultiPart is set", async () => {
    const island1 = cubeTriangles(10);
    const island2 = translateTriangles(cubeTriangles(10), 30, 0, 0);
    const meshPath = await writeMesh("multi-island.stl", buildBinaryStl([...island1, ...island2]));
    const result = await validateMesh({ meshPath, options: { allowMultiPart: true } });
    expect(result.gate.ok).toBe(true);
    expect(result.gate.badge).toBe("amber");
  });

  // ── COUNTEREXAMPLES: malformed/missing mesh, AC "clean typed error, never an uncaught stack trace" ──

  it("missing mesh file -> typed MESH_PARSE_FAILED, not an uncaught fs error", async () => {
    await expect(validateMesh({ meshPath: join(workDir, "does-not-exist.stl") })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ScadForgeError);
      expect((err as ScadForgeError).error_code).toBe("MESH_PARSE_FAILED");
      return true;
    });
  });

  it("malformed/truncated mesh file -> typed MESH_PARSE_FAILED, not an uncaught stack trace", async () => {
    const meshPath = await writeMesh("garbage.stl", Buffer.from("not an stl file, just text\n".repeat(5), "utf8"));
    await expect(validateMesh({ meshPath })).rejects.toBeInstanceOf(ScadForgeError);
  });

  it("empty mesh file -> typed MESH_PARSE_FAILED", async () => {
    const meshPath = await writeMesh("empty.stl", Buffer.alloc(0));
    await expect(validateMesh({ meshPath })).rejects.toMatchObject({ error_code: "MESH_PARSE_FAILED" });
  });

  // Concurrency: validateMesh loads a shared, lazily-initialized manifold-3d
  // WASM module (see getManifoldModule) -- concurrent calls must not race or
  // corrupt each other's results.
  it("handles concurrent validateMesh calls correctly (shared WASM module init)", async () => {
    const goodPath = await writeMesh("good-concurrent.stl", buildBinaryStl(cubeTriangles(15)));
    const badPath = await writeMesh("bad-concurrent.stl", buildBinaryStl(openCubeTriangles(15)));
    const [goodResults, badResults] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => validateMesh({ meshPath: goodPath }))),
      Promise.all(Array.from({ length: 5 }, () => validateMesh({ meshPath: badPath })))
    ]);
    for (const r of goodResults) {
      expect(r.report.manifold).toBe(true);
      expect(r.report.volume_mm3).toBe(15 ** 3);
    }
    for (const r of badResults) {
      expect(r.report.manifold).toBe(false);
    }
  });
});
