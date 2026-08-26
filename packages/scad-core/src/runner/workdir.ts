// @scadforge/scad-core — per-render staging directory helper.
//
// Every render/export/validate invocation gets its own `mkdtemp` work
// directory (SDP §7 / Spike 2), bind-mounted at `/work` in the container.
// Malicious input containment: OpenSCAD only ever sees this throwaway
// directory bind-mounted read/write at `/work` — an `import("/etc/passwd")`
// or `include </etc/passwd>` inside the `.scad` source resolves against the
// CONTAINER's filesystem, not the host's, and the container is `--rm`'d
// immediately after; nothing outside `/work` (this mkdtemp) is ever bound in.
//
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ScadForgeError } from "../errors.js";

export interface StagedWork {
  /** The mkdtemp work directory (host path), bind-mounted at `/work`. */
  dir: string;
  /** The staged `.scad` file's basename, as seen inside the container (`/work/<modelName>`). */
  modelName: string;
  /** Removes the staged directory. Safe to call more than once. */
  cleanup(): Promise<void>;
}

export interface StageWorkOptions {
  /** Additional library directories to copy into the work dir root (BOSL2/MCAD mounting). */
  libraryPaths?: readonly string[];
}

/**
 * Stages a fresh temp directory for one render/export/validate invocation:
 * copies `scadPath` in by its basename, plus any `libraryPaths` directories
 * (each copied to the work root under its own basename, so `include
 * <BOSL2/std.scad>`-style relative includes resolve). Throws a typed
 * `ScadForgeError('RENDER_FAILED', ...)` on any filesystem failure.
 */
export async function stageWork(scadPath: string, options: StageWorkOptions = {}): Promise<StagedWork> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "scadforge-"));
  } catch (err) {
    throw new ScadForgeError("RENDER_FAILED", `failed to create work directory: ${(err as Error).message}`, {
      cause: err
    });
  }

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup; never let this mask the real result/error */
    });
  };

  try {
    const modelName = basename(scadPath);
    await cp(scadPath, join(dir, modelName));
    await mkdir(join(dir, "views"), { recursive: true });
    for (const libPath of options.libraryPaths ?? []) {
      const libName = basename(libPath);
      await cp(libPath, join(dir, libName), { recursive: true });
    }
    return { dir, modelName, cleanup };
  } catch (err) {
    await cleanup();
    throw new ScadForgeError("RENDER_FAILED", `failed to stage work directory: ${(err as Error).message}`, {
      cause: err
    });
  }
}
