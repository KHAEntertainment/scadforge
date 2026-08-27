// @scadforge/scad-core — OpenSCAD CLI runner: dockerized invocation.
//
// Every invocation runs the pinned OpenSCAD image (types.ts `OPENSCAD_IMAGE`,
// overridable via `SCADFORGE_OPENSCAD_IMAGE` for local dev / CI substitution —
// packages/scad-core never resolves a floating tag itself), passes args as an
// ARRAY (no shell interpolation — SDP §7 / Spike 2), and is wrapped in a
// timeout + SIGKILL. Reimplemented production-grade from Spike 2's
// `run-views.mjs` harness; not imported from spikes/.
//
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { DEFAULT_RENDER_TIMEOUT_MS, OPENSCAD_IMAGE } from "../types.js";
import { ScadForgeError } from "../errors.js";

/** Env var that overrides the pinned image digest (seam with #15's docker/compose ownership). */
export const OPENSCAD_IMAGE_ENV_VAR = "SCADFORGE_OPENSCAD_IMAGE";

/** Resolves the OpenSCAD image to invoke: env override, else the frozen pinned digest. */
export function resolveOpenscadImage(): string {
  const override = process.env[OPENSCAD_IMAGE_ENV_VAR];
  return override && override.trim().length > 0 ? override : OPENSCAD_IMAGE;
}

export interface RunOpenscadOptions {
  /** Host directory bind-mounted at `/work` inside the container. */
  cwd: string;
  /** Defaults to {@link DEFAULT_RENDER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Extra `docker run` args inserted before the image name (e.g. more mounts). */
  extraDockerArgs?: string[];
}

export interface RunOpenscadResult {
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Runs the pinned OpenSCAD image via `docker run`, args-as-array (no shell),
 * bind-mounting `cwd` at `/work`. Enforces a timeout with SIGKILL. Never
 * throws a bare Error — always a {@link ScadForgeError} with a typed code:
 *
 * - `TIMEOUT` — the invocation exceeded `timeoutMs` and was SIGKILLed.
 * - `RENDER_FAILED` — the process exited non-zero, or `docker` itself could
 *   not be spawned (missing binary, daemon down, etc.).
 */
export function runOpenscad(args: readonly string[], options: RunOpenscadOptions): Promise<RunOpenscadResult> {
  const { cwd, timeoutMs = DEFAULT_RENDER_TIMEOUT_MS, extraDockerArgs = [] } = options;
  const image = resolveOpenscadImage();

  return new Promise<RunOpenscadResult>((resolvePromise, reject) => {
    // The pinned base image (`openscad/openscad`) has no ENTRYPOINT/CMD set to
    // `openscad` — it defaults to `bash` (verified against the pinned digest).
    // Consuming it directly (rather than via #15's docker/ Dockerfile wrapper)
    // means every invocation must name the binary explicitly.
    const dockerArgs = [
      "run",
      "--rm",
      "-v",
      `${cwd}:/work`,
      "-w",
      "/work",
      ...extraDockerArgs,
      image,
      "openscad",
      ...args
    ];

    const start = process.hrtime.bigint();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new ScadForgeError("RENDER_FAILED", `failed to spawn docker: ${(err as Error).message}`, { cause: err }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new ScadForgeError(
          "TIMEOUT",
          `openscad timed out after ${timeoutMs}ms and was killed: ${args.join(" ")}`
        )
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ScadForgeError("RENDER_FAILED", `docker process error: ${err.message}`, { cause: err }));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (code !== 0) {
        reject(
          new ScadForgeError(
            "RENDER_FAILED",
            `openscad exited ${code}: ${filterOpenscadDiagnostics(stderr) || "(no diagnostics)"}`
          )
        );
        return;
      }
      resolvePromise({ stdout, stderr, ms });
    });
  });
}

/**
 * Filters OpenSCAD's stderr down to `ERROR:` / `WARNING:` / `TRACE:` lines.
 * OpenSCAD prints ~10 lines of cache statistics on every invocation; passing
 * them through burns tokens for no signal (Spike 3 §7.2 / contract.ts
 * `TOOL_RESULT_RULES.filterStderr`). Returns `null`, never `""`, when there is
 * nothing to report.
 */
export function filterOpenscadDiagnostics(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(ERROR|WARNING|TRACE):/.test(l));
  return lines.length > 0 ? lines.join("\n") : null;
}
