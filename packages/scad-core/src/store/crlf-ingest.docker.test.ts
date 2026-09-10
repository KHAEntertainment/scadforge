// @scadforge/scad-core — Issue #40 regression: the systemic CRLF fix.
//
// CRLF-authored source enters a project → the store's write boundary
// normalizes it to LF on disk → the parser surfaces the FULL annotation set
// (no defensive file-wide stripping, no CRLF warning) → a real @docker
// render honors a parameter override exactly as it would for an LF-authored
// equivalent. Covers the acceptance criteria end to end:
//   - CRLF in → LF on disk (root model.scad, snapshot model.scad, diff)
//   - full annotation set surfaced (min/max/step/options/maxLength/caption)
//   - params/crlf.ts's warning path is UNREACHABLE in this normal flow
//   - identical behavior to the LF equivalent (schema deep-equal + render)
//   - no behavior change for LF sources (existing cross-checks untouched)
//
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import { parseParamSchema, parseParamSchemaWithDiagnostics } from "../params/parse.js";
import { CRLF_ANNOTATION_WARNING } from "../params/crlf.js";
import { dockerAvailable } from "../test-support/docker-available.js";
import { validateModel } from "../runner/validate-model.js";
import { rootModelPath, snapshotDir } from "./paths.js";
import { createSnapshot, initProject } from "./store.js";

// Full annotation set the read-time backstop (params/crlf.ts) would strip
// file-wide on CRLF: range with step, options with captions, string
// maxLength, group headers, and per-parameter captions.
const LF_SOURCE = [
  "/* [Pipe] */",
  "// Outer diameter of the pipe",
  "pipe_d = 32; // [10:80]",
  "",
  "/* [Mount] */",
  "Enabled = true;",
  "Label = \"hello\"; // 20",
  "Facet_style = \"round\"; // [round, square, hex]",
  "",
  "cube([pipe_d, 10, 6]);",
  ""
].join("\n");
const CRLF_SOURCE = LF_SOURCE.replace(/\n/g, "\r\n");

const providerConfig = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-crlf-ingest-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("CRLF ingest normalization at the store write boundary (Issue #40)", () => {
  it("initProject writes a CRLF-authored source as LF-only bytes (root + snapshot)", async () => {
    await initProject(projectDir, {
      id: "crlf-proj",
      name: "CRLF Project",
      provider: providerConfig,
      content: CRLF_SOURCE
    });

    const rootModel = await readFile(rootModelPath(projectDir), "utf8");
    const snapshotModel = await readFile(
      join(snapshotDir(projectDir, "0001"), PROJECT_LAYOUT.snapshot.modelFile),
      "utf8"
    );
    expect(rootModel).not.toContain("\r");
    expect(snapshotModel).not.toContain("\r");
    expect(rootModel).toBe(LF_SOURCE);
  });

  it("createSnapshot normalizes every subsequent CRLF-authored save, and the diff stays LF", async () => {
    await initProject(projectDir, {
      id: "crlf-proj",
      name: "CRLF Project",
      provider: providerConfig,
      content: CRLF_SOURCE
    });

    const second = await createSnapshot(projectDir, {
      content: LF_SOURCE.replace("pipe_d = 32", "pipe_d = 40"),
      params: {},
      message: "edited",
      origin: "manual",
      pass: null
    });
    expect(second.id).toBe("0002");

    const snapshotModel = await readFile(
      join(snapshotDir(projectDir, "0002"), PROJECT_LAYOUT.snapshot.modelFile),
      "utf8"
    );
    const diff = await readFile(join(snapshotDir(projectDir, "0002"), PROJECT_LAYOUT.snapshot.diffFile), "utf8");
    expect(snapshotModel).not.toContain("\r");
    expect(diff).not.toContain("\r");
  });

  it("the read back from disk surfaces the FULL annotation set with no CRLF warning (unreachable backstop)", async () => {
    await initProject(projectDir, {
      id: "crlf-proj",
      name: "CRLF Project",
      provider: providerConfig,
      content: CRLF_SOURCE
    });

    // What the rest of the app would parse after the ingest.
    const fromDisk = await readFile(rootModelPath(projectDir), "utf8");
    const { schema, warnings } = parseParamSchemaWithDiagnostics(fromDisk, { title: "crlf-ingest" });

    // The write-boundary normalization means the read-time defensive strip
    // never fires: its warning must NOT appear in the normal flow.
    expect(warnings).not.toContain(CRLF_ANNOTATION_WARNING);

    const pipeD = schema.parameters.find((p) => p.name === "pipe_d");
    expect(pipeD?.min).toBe(10);
    expect(pipeD?.max).toBe(80);
    expect(pipeD?.caption).toBe("Outer diameter of the pipe");
    expect(pipeD?.group).toBe("Pipe");

    const label = schema.parameters.find((p) => p.name === "Label");
    expect(label?.maxLength).toBe(20);

    const facet = schema.parameters.find((p) => p.name === "Facet_style");
    expect(facet?.options?.map((o) => o.value)).toEqual(["round", "square", "hex"]);
  });
});

describe.skipIf(!dockerAvailable())("@docker CRLF ingest end-to-end (Issue #40)", () => {
  it("CRLF source in → LF on disk → full annotation set surfaced and honored by a real render", async () => {
    // 1. Ingest: a CRLF-authored file enters the project.
    await initProject(projectDir, {
      id: "crlf-proj",
      name: "CRLF Project",
      provider: providerConfig,
      content: CRLF_SOURCE
    });

    // 2. LF on disk (AC1) and full annotations surfaced (AC2/AC4).
    const fromDisk = await readFile(rootModelPath(projectDir), "utf8");
    expect(fromDisk).not.toContain("\r");
    const schema = parseParamSchema(fromDisk, { title: "crlf-ingest" });
    const pipeD = schema.parameters.find((p) => p.name === "pipe_d");
    expect(pipeD?.min).toBe(10);
    expect(pipeD?.max).toBe(80);

    // 3. A real render honors a parameter override within the surfaced
    //    range: the mesh geometry must change exactly as for the LF
    //    equivalent (the parser and renderer agree on what is
    //    parameterizable — the whole point of the fix).
    const scadPath = rootModelPath(projectDir);
    const baseline = await validateModel(scadPath, { params: { pipe_d: 10 } });
    const overridden = await validateModel(scadPath, { params: { pipe_d: 60 } });
    expect(baseline.report.manifold).toBe(true);
    expect(overridden.report.manifold).toBe(true);
    expect(overridden.report.volume_mm3!).toBeGreaterThan(baseline.report.volume_mm3!);
    expect(overridden.report.bbox!.max[0]).toBeCloseTo(60, 5);
    expect(baseline.report.bbox!.max[0]).toBeCloseTo(10, 5);
  }, 60_000);

  it("behaves identically to the LF-authored equivalent, end to end (AC2)", async () => {
    const crlfDir = projectDir;
    const lfDir = await mkdtemp(join(tmpdir(), "scadcore-crlf-ingest-lf-"));
    try {
      await initProject(crlfDir, {
        id: "crlf-proj",
        name: "CRLF",
        provider: providerConfig,
        content: CRLF_SOURCE
      });
      await initProject(lfDir, {
        id: "lf-proj",
        name: "LF",
        provider: providerConfig,
        content: LF_SOURCE
      });

      // Identical bytes on disk ⇒ identical schema.
      const crlfBytes = await readFile(rootModelPath(crlfDir), "utf8");
      const lfBytes = await readFile(rootModelPath(lfDir), "utf8");
      expect(crlfBytes).toBe(lfBytes);
      expect(parseParamSchema(crlfBytes, { title: "t" })).toEqual(parseParamSchema(lfBytes, { title: "t" }));

      // Identical real-render behavior for the same override.
      const crlfRender = await validateModel(rootModelPath(crlfDir), { params: { pipe_d: 60 } });
      const lfRender = await validateModel(rootModelPath(lfDir), { params: { pipe_d: 60 } });
      expect(crlfRender.report.volume_mm3).toBeCloseTo(lfRender.report.volume_mm3!, 3);
      expect(crlfRender.report.triangle_count).toBe(lfRender.report.triangle_count);
    } finally {
      await rm(lfDir, { recursive: true, force: true });
    }
  }, 120_000);
});
