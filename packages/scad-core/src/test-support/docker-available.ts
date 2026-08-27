// Shared test helper: detects whether a working Docker daemon is reachable,
// so `@docker`-tagged tests can `describe.skipIf(!dockerAvailable())`
// instead of failing hard in an environment with no Docker (Issue #14 AC).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let cached: boolean | undefined;

export function dockerAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    cached = result.status === 0;
  } catch {
    cached = false;
  }
  return cached;
}

/** Absolute path to `packages/scad-core/test/fixtures/<name>`. */
export function fixture(name: string): string {
  return fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
}
