// Unit tests for the docker runner's OWN spawn/timeout/error-handling logic,
// using a fake `docker` script on PATH so these run without a real Docker
// daemon (the `@docker`-tagged suites separately exercise the real pinned
// image -- see render.docker.test.ts / export.docker.test.ts / etc.).
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScadForgeError } from "../errors.js";
import { filterOpenscadDiagnostics, OPENSCAD_IMAGE_ENV_VAR, resolveOpenscadImage, runOpenscad } from "./docker.js";

let fakeBinDir: string;
let workDir: string;
let originalPath: string | undefined;
let originalImageEnv: string | undefined;

beforeEach(async () => {
  fakeBinDir = await mkdtemp(join(tmpdir(), "scadcore-fake-docker-"));
  workDir = await mkdtemp(join(tmpdir(), "scadcore-docker-workdir-"));
  originalPath = process.env.PATH;
  originalImageEnv = process.env[OPENSCAD_IMAGE_ENV_VAR];
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalImageEnv === undefined) delete process.env[OPENSCAD_IMAGE_ENV_VAR];
  else process.env[OPENSCAD_IMAGE_ENV_VAR] = originalImageEnv;
  await rm(fakeBinDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

async function installFakeDocker(script: string): Promise<void> {
  const path = join(fakeBinDir, "docker");
  await writeFile(path, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(path, 0o755);
}

describe("resolveOpenscadImage / SCADFORGE_OPENSCAD_IMAGE override", () => {
  it("defaults to the frozen pinned digest", () => {
    delete process.env[OPENSCAD_IMAGE_ENV_VAR];
    expect(resolveOpenscadImage()).toContain("openscad/openscad@sha256:");
  });

  it("honors an explicit env override (the seam with #15's docker/compose image)", () => {
    process.env[OPENSCAD_IMAGE_ENV_VAR] = "my-registry/openscad:custom";
    expect(resolveOpenscadImage()).toBe("my-registry/openscad:custom");
  });

  it("ignores a blank override and falls back to the pinned digest", () => {
    process.env[OPENSCAD_IMAGE_ENV_VAR] = "   ";
    expect(resolveOpenscadImage()).toContain("openscad/openscad@sha256:");
  });
});

describe("runOpenscad", () => {
  it("names the openscad binary explicitly -- never relies on the image's ENTRYPOINT", async () => {
    await installFakeDocker('echo "$@" > "'+join(workDir, "captured-args.txt")+'"');
    await runOpenscad(["-o", "/work/out.png", "/work/model.scad"], { cwd: workDir });
    const { readFile } = await import("node:fs/promises");
    const captured = await readFile(join(workDir, "captured-args.txt"), "utf8");
    // args: run --rm -v <cwd>:/work -w /work <image> openscad -o /work/out.png /work/model.scad
    expect(captured).toContain(" openscad -o /work/out.png /work/model.scad");
  });

  it("resolves on a zero exit with stdout/stderr and timing", async () => {
    await installFakeDocker('echo "out"; echo "err" >&2; exit 0');
    const result = await runOpenscad(["--version"], { cwd: workDir });
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("a non-zero exit -> typed RENDER_FAILED, not a bare rejection", async () => {
    await installFakeDocker('echo "ERROR: bad geometry" >&2; exit 1');
    await expect(runOpenscad(["-o", "/work/out.png"], { cwd: workDir })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ScadForgeError);
      expect((err as ScadForgeError).error_code).toBe("RENDER_FAILED");
      expect((err as ScadForgeError).message).toContain("bad geometry");
      return true;
    });
  });

  it("docker missing from PATH entirely -> typed RENDER_FAILED, never an uncaught spawn ENOENT", async () => {
    process.env.PATH = "/nonexistent-bin-dir-for-test";
    await expect(runOpenscad(["--version"], { cwd: workDir })).rejects.toBeInstanceOf(ScadForgeError);
  });

  // COUNTEREXAMPLE: exceeding the timeout -- the process must be SIGKILLed and reported, never hang.
  it("kills a hung invocation on timeout and reports TIMEOUT", async () => {
    await installFakeDocker("sleep 30");
    const start = Date.now();
    await expect(runOpenscad(["--version"], { cwd: workDir, timeoutMs: 200 })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ScadForgeError);
      expect((err as ScadForgeError).error_code).toBe("TIMEOUT");
      return true;
    });
    // The rejection must arrive close to the timeout, not after the full sleep.
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe("filterOpenscadDiagnostics", () => {
  it("keeps only ERROR/WARNING/TRACE lines and drops cache-statistics noise", () => {
    const stderr = [
      "Geometries in cache: 3",
      "Geometry cache size in bytes: 2568",
      "WARNING: something odd",
      "ERROR: this failed",
      "TRACE: called from foo()",
      "CGAL cache size in bytes: 0"
    ].join("\n");
    expect(filterOpenscadDiagnostics(stderr)).toBe("WARNING: something odd\nERROR: this failed\nTRACE: called from foo()");
  });

  it("returns null (never an empty string) when there is nothing to report", () => {
    expect(filterOpenscadDiagnostics("Geometries in cache: 1\nTotal rendering time: 0:00:00.1\n")).toBeNull();
  });

  it("handles empty stderr", () => {
    expect(filterOpenscadDiagnostics("")).toBeNull();
  });
});
