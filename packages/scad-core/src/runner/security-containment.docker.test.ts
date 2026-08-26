// @docker -- malicious-input containment. A `.scad` source that tries to
// `import()` an absolute host path must stay confined to the container's
// filesystem (only `/work`, the per-render mkdtemp, is bind-mounted) and must
// fail CLEANLY -- never leak host file contents, never crash the runner with
// an uncaught exception.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerAvailable, fixture } from "../test-support/docker-available.js";
import { renderViews } from "./render.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "scadcore-security-out-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe.skipIf(!dockerAvailable())("@docker security containment (real pinned OpenSCAD image)", () => {
  it('import("/etc/passwd") is confined to the container and never leaks file content -- OpenSCAD reports "Unsupported file format" and renders an empty scene, it does not crash and never echoes file bytes', async () => {
    let hostPasswd = "";
    try {
      hostPasswd = await readFile("/etc/passwd", "utf8");
    } catch {
      hostPasswd = ""; // sandboxed test runner may not expose this either way
    }

    const result = await renderViews({ scadPath: fixture("malicious-import.scad"), outDir, views: ["iso"] });

    // Empirically verified against the pinned image: a failed import() is a
    // GEOMETRY-level error, not a parse error -- OpenSCAD still exits 0 and
    // produces a (blank) PNG of whatever *did* render. The containment
    // property under test is that this NEVER surfaces real file content --
    // path resolution stays inside the container's own filesystem (the only
    // thing bind-mounted is this render's throwaway /work dir), and
    // import()'s format-sniffing never reads/echoes arbitrary file bytes.
    expect(result.views[0].stderr ?? "").toMatch(/unsupported file format/i);

    if (hostPasswd.includes("root:")) {
      expect(result.views[0].stderr ?? "").not.toContain("root:");
      const pngBytes = await readFile(join(outDir, "iso.png"));
      expect(pngBytes.toString("latin1")).not.toContain("root:");
    }
  }, 60_000);
});
