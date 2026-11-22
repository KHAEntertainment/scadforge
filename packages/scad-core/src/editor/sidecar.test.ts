// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditorFeature, EditorSidecar, EditorSnapshotRef, ProjectManifest } from "@scadforge/protocol";
import { PROJECT_LAYOUT } from "@scadforge/protocol";
import { ScadForgeError } from "../errors.js";
import { withRecoveredProject } from "../store/recovered.js";
import type { LockedProject } from "../store/recovered.js";
import { metaDir, projectFilePath, snapshotDir } from "../store/paths.js";
import { computeSourceRevision } from "../store/revision.js";
import { canonicalJson, editorRevision, sidecarDigest } from "./canonical.js";
import {
  EMPTY_SIDECAR,
  captureSidecarForSnapshotLocked,
  quarantine,
  readSidecarLocked,
  readSnapshotSidecarLocked,
  serializeCanonicalSidecar,
  sidecarPath,
  snapshotSidecarPath,
  writeSidecarBytesLocked,
  writeSidecarLocked
} from "./sidecar.js";

const PROVIDER = { provider: "claude-agent-sdk", model: null, max_passes: 2 };

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-sidecar-test-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** Hand-builds a minimal `.scadforge/project.json` -- deliberately NOT going through `initProject` (store.ts), so this test file stays fully decoupled from `store.ts` (mirrors `canonical.test.ts`'s own isolation). */
async function seedProjectManifest(overrides: Partial<ProjectManifest> = {}): Promise<ProjectManifest> {
  await mkdir(metaDir(projectDir), { recursive: true });
  const manifest: ProjectManifest = {
    schema_version: 1,
    id: "proj-1",
    name: "Test",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    openscad_image: "openscad/openscad@sha256:test",
    openscad_version: "2026.01.19",
    provider: PROVIDER,
    head: null,
    ...overrides
  };
  await writeFile(projectFilePath(projectDir), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function makeFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: randomUUID(),
    label: "Width",
    projectId: randomUUID(),
    createdAtRevision: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "width", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
    ...overrides
  };
}

function withCtx<T>(fn: (ctx: LockedProject) => Promise<T>): Promise<T> {
  return withRecoveredProject(projectDir, fn);
}

// ═════════════════════════════════════════════════════════════════════════════
// readSidecarLocked
// ═════════════════════════════════════════════════════════════════════════════

describe("readSidecarLocked (#87 B3): exact five-status derivation", () => {
  it("no editor_store_version marker -> legacy-empty, canonical empty sidecar, no file created", async () => {
    await seedProjectManifest();

    const result = await withCtx((ctx) => readSidecarLocked(ctx));

    expect(result).toEqual({
      status: "legacy-empty",
      sidecar: EMPTY_SIDECAR,
      digest: sidecarDigest(EMPTY_SIDECAR),
      error: null
    });
    await expect(readFile(sidecarPath(projectDir))).rejects.toThrow(); // never created by a read
  });

  it("marker present, .scadforge/editor.json absent -> missing", async () => {
    await seedProjectManifest({ editor_store_version: 1 });

    const result = await withCtx((ctx) => readSidecarLocked(ctx));

    expect(result).toEqual({ status: "missing", sidecar: null, digest: null, error: null });
  });

  it("marker present, bytes not valid JSON -> corrupt, and the bytes are byte-identical after the read", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const corruptBytes = "{ not json";
    await writeFile(sidecarPath(projectDir), corruptBytes, "utf8");

    const result = await withCtx((ctx) => readSidecarLocked(ctx));

    expect(result.status).toBe("corrupt");
    expect(result.sidecar).toBeNull();
    expect(result.digest).toBeNull();
    expect(result.error).toBeInstanceOf(ScadForgeError);
    expect((result.error as ScadForgeError).error_code).toBe("INTERNAL_ERROR");
    expect(await readFile(sidecarPath(projectDir), "utf8")).toBe(corruptBytes);
  });

  it("marker present, valid JSON but not an object -> corrupt", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    await writeFile(sidecarPath(projectDir), JSON.stringify([1, 2, 3]), "utf8");

    const result = await withCtx((ctx) => readSidecarLocked(ctx));
    expect(result.status).toBe("corrupt");
  });

  it("marker present, version !== 1 -> unsupported-version, checked BEFORE full schema validation (Tech Lead correction C3)", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    // A body that would ALSO fail parseEditorSidecar (missing `features`) --
    // still must be classified by version first, never corrupt.
    await writeFile(sidecarPath(projectDir), JSON.stringify({ version: 2 }), "utf8");

    const result = await withCtx((ctx) => readSidecarLocked(ctx));
    expect(result).toEqual({ status: "unsupported-version", sidecar: null, digest: null, error: null });
  });

  it("marker present, version === 1, fails parseEditorSidecar (duplicate featureId) -> corrupt, bytes preserved", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const feature = makeFeature();
    const badBytes = JSON.stringify({ version: 1, features: [feature, feature] });
    await writeFile(sidecarPath(projectDir), badBytes, "utf8");

    const result = await withCtx((ctx) => readSidecarLocked(ctx));

    expect(result.status).toBe("corrupt");
    expect(await readFile(sidecarPath(projectDir), "utf8")).toBe(badBytes);
  });

  it("marker present, version === 1, valid -> ready with the exact B1 sidecarDigest", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const sidecar: EditorSidecar = { version: 1, features: [makeFeature()] };
    await writeFile(sidecarPath(projectDir), canonicalJson(sidecar), "utf8");

    const result = await withCtx((ctx) => readSidecarLocked(ctx));

    expect(result.status).toBe("ready");
    expect(result.sidecar).toEqual(sidecar);
    expect(result.digest).toBe(sidecarDigest(sidecar));
  });

  it("a corrupt project.json itself throws, never encoded as a sidecar status", async () => {
    await mkdir(metaDir(projectDir), { recursive: true });
    await writeFile(projectFilePath(projectDir), "{ not json", "utf8");

    await expect(withCtx((ctx) => readSidecarLocked(ctx))).rejects.toMatchObject({ error_code: "INTERNAL_ERROR" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// writeSidecarLocked / writeSidecarBytesLocked
// ═════════════════════════════════════════════════════════════════════════════

describe("writeSidecarLocked (#87 B3)", () => {
  it("on a legacy project writes canonical bytes via temp file + rename and flips editor_store_version:1 in the same publication; a second read is ready", async () => {
    await seedProjectManifest();
    const sidecar: EditorSidecar = { version: 1, features: [makeFeature()] };

    const written = await withCtx((ctx) => writeSidecarLocked(ctx, sidecar));
    expect(written.sidecar).toEqual(sidecar);
    expect(written.digest).toBe(sidecarDigest(sidecar));

    // No leftover temp file.
    const entries = await readdir(metaDir(projectDir));
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

    const manifest = JSON.parse(await readFile(projectFilePath(projectDir), "utf8")) as ProjectManifest;
    expect(manifest.editor_store_version).toBe(1);

    const second = await withCtx((ctx) => readSidecarLocked(ctx));
    expect(second.status).toBe("ready");
    expect(second.sidecar).toEqual(sidecar);
  });

  it("does not downgrade an already-set marker -- a second write on a modern project only rewrites the sidecar bytes", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const before = JSON.parse(await readFile(projectFilePath(projectDir), "utf8")) as ProjectManifest;

    const sidecar: EditorSidecar = { version: 1, features: [makeFeature()] };
    await withCtx((ctx) => writeSidecarLocked(ctx, sidecar));

    const after = JSON.parse(await readFile(projectFilePath(projectDir), "utf8")) as ProjectManifest;
    expect(after.editor_store_version).toBe(1);
    expect(after.updated).toBe(before.updated); // project.json was never rewritten -- only editor.json was
  });

  it("refuses to overwrite a CORRUPT root sidecar (Tech Lead correction C2); bytes are byte-identical afterward", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const corruptBytes = "{ not json";
    await writeFile(sidecarPath(projectDir), corruptBytes, "utf8");

    await expect(withCtx((ctx) => writeSidecarLocked(ctx, EMPTY_SIDECAR))).rejects.toMatchObject({
      error_code: "INTERNAL_ERROR"
    });
    expect(await readFile(sidecarPath(projectDir), "utf8")).toBe(corruptBytes);
  });

  it("refuses to overwrite an UNSUPPORTED-VERSION root sidecar", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const futureBytes = JSON.stringify({ version: 2, somethingNew: true });
    await writeFile(sidecarPath(projectDir), futureBytes, "utf8");

    await expect(withCtx((ctx) => writeSidecarLocked(ctx, EMPTY_SIDECAR))).rejects.toMatchObject({
      error_code: "INTERNAL_ERROR"
    });
    expect(await readFile(sidecarPath(projectDir), "utf8")).toBe(futureBytes);
  });

  it("writes over a MISSING root sidecar without complaint (nothing to preserve)", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    await expect(withCtx((ctx) => writeSidecarBytesLocked(ctx, EMPTY_SIDECAR))).resolves.toMatchObject({
      digest: sidecarDigest(EMPTY_SIDECAR)
    });
  });

  it("quarantine then writeSidecarLocked succeeds; the quarantine file holds the original bytes", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const corruptBytes = "{ not json";
    await writeFile(sidecarPath(projectDir), corruptBytes, "utf8");

    const quarantinedPath = await withCtx((ctx) => quarantine(ctx, sidecarPath(projectDir)));
    expect(await readFile(quarantinedPath, "utf8")).toBe(corruptBytes);
    await expect(readFile(sidecarPath(projectDir))).rejects.toThrow(); // moved, not copied

    const sidecar: EditorSidecar = { version: 1, features: [] };
    const written = await withCtx((ctx) => writeSidecarLocked(ctx, sidecar));
    expect(written.digest).toBe(sidecarDigest(sidecar));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// readSnapshotSidecarLocked
// ═════════════════════════════════════════════════════════════════════════════

/** Hand-builds `history/<id>/manifest.json` -- just enough shape for `readSnapshotSidecarLocked`'s own reads (this test file stays decoupled from `store.ts`). */
async function seedSnapshotManifest(id: string, editor?: EditorSnapshotRef): Promise<void> {
  const dir = snapshotDir(projectDir, id);
  await mkdir(dir, { recursive: true });
  const manifest = {
    id,
    parent: null,
    timestamp: new Date().toISOString(),
    message: "",
    origin: "manual",
    pass: null,
    files: { model_scad: "model.scad", params_json: "params.json", message_md: "message.md", validation_json: null, diff_patch: null },
    params: {},
    renders: [],
    validation: null,
    annotations: [],
    ...(editor ? { editor } : {})
  };
  await writeFile(join(dir, PROJECT_LAYOUT.snapshot.manifestFile), JSON.stringify(manifest, null, 2), "utf8");
}

describe("readSnapshotSidecarLocked (#87 B3)", () => {
  it("no descriptor on a pre-S3 snapshot -> legacy-empty", async () => {
    await seedProjectManifest();
    await seedSnapshotManifest("0001");

    const result = await withCtx((ctx) => readSnapshotSidecarLocked(ctx, "0001"));
    expect(result).toEqual({ status: "legacy-empty", sidecar: EMPTY_SIDECAR, digest: sidecarDigest(EMPTY_SIDECAR), error: null });
  });

  it("descriptor present, file missing -> corrupt", async () => {
    await seedProjectManifest();
    await seedSnapshotManifest("0001", { version: 1, file: "editor.json", sha256: "a".repeat(64) });

    const result = await withCtx((ctx) => readSnapshotSidecarLocked(ctx, "0001"));
    expect(result.status).toBe("corrupt");
  });

  it("descriptor present, file tampered (digest mismatch) -> corrupt", async () => {
    await seedProjectManifest();
    const sidecar: EditorSidecar = { version: 1, features: [] };
    const realDigest = sidecarDigest(sidecar);
    await seedSnapshotManifest("0001", { version: 1, file: "editor.json", sha256: realDigest });
    // Tamper: persist a DIFFERENT sidecar than the descriptor's digest names.
    await writeFile(snapshotSidecarPath(projectDir, "0001"), canonicalJson({ version: 1, features: [makeFeature()] }), "utf8");

    const result = await withCtx((ctx) => readSnapshotSidecarLocked(ctx, "0001"));
    expect(result.status).toBe("corrupt");
  });

  it("descriptor malformed (wrong version/file on disk, bypassing the frozen TS type) -> corrupt", async () => {
    await seedProjectManifest();
    await seedSnapshotManifest("0001", { version: 2, file: "editor.json", sha256: "a".repeat(64) } as unknown as EditorSnapshotRef);

    const result = await withCtx((ctx) => readSnapshotSidecarLocked(ctx, "0001"));
    expect(result.status).toBe("corrupt");
  });

  it("descriptor present, file valid, digest matches -> ready", async () => {
    await seedProjectManifest();
    const sidecar: EditorSidecar = { version: 1, features: [makeFeature()] };
    const digest = sidecarDigest(sidecar);
    await seedSnapshotManifest("0001", { version: 1, file: "editor.json", sha256: digest });
    await writeFile(snapshotSidecarPath(projectDir, "0001"), canonicalJson(sidecar), "utf8");

    const result = await withCtx((ctx) => readSnapshotSidecarLocked(ctx, "0001"));
    expect(result).toEqual({ status: "ready", sidecar, digest, error: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// captureSidecarForSnapshotLocked
// ═════════════════════════════════════════════════════════════════════════════

describe("captureSidecarForSnapshotLocked (#87 B3): the store.ts writeSnapshotFiles seam", () => {
  it("refuses (naming the status and the absolute path) when the root sidecar is missing/corrupt/unsupported-version", async () => {
    await seedProjectManifest({ editor_store_version: 1 }); // marker set, file absent -> missing

    await expect(withCtx((ctx) => captureSidecarForSnapshotLocked(ctx))).rejects.toMatchObject({
      error_code: "INTERNAL_ERROR",
      message: expect.stringContaining("missing")
    });
    await expect(withCtx((ctx) => captureSidecarForSnapshotLocked(ctx))).rejects.toMatchObject({
      message: expect.stringContaining(sidecarPath(projectDir))
    });
  });

  it("on a legacy-empty project, returns the canonical empty sidecar bytes to stage and reports legacyMarkerFlip: true, without writing", async () => {
    await seedProjectManifest(); // no marker

    const capture = await withCtx((ctx) => captureSidecarForSnapshotLocked(ctx));

    expect(capture.legacyMarkerFlip).toBe(true);
    expect(capture.descriptor).toEqual({ version: 1, file: "editor.json", sha256: sidecarDigest(EMPTY_SIDECAR) });
    expect(capture.bytes).toBe(canonicalJson(EMPTY_SIDECAR));
    // A PURE READ (S3-B ticket B6, Issue #98 F1 fix, PR #103): this function
    // no longer establishes the root sidecar itself -- the caller
    // (`store.ts`'s `buildSnapshotIntent`) stages the RETURNED bytes as part
    // of its OWN transaction. The root file must still be completely absent
    // here; the end-to-end "the root sidecar exists after the first
    // snapshot" guarantee is covered at the store level instead
    // (`store-editor-extension.test.ts`'s legacy-marker-flip case, and
    // `store.test.ts`'s "a brand-new project is S3-modern from its very
    // first snapshot").
    await expect(readFile(sidecarPath(projectDir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("on a ready project, captures the CURRENT root sidecar unchanged and reports legacyMarkerFlip: false", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const sidecar: EditorSidecar = { version: 1, features: [makeFeature()] };
    await withCtx((ctx) => writeSidecarLocked(ctx, sidecar));

    const capture = await withCtx((ctx) => captureSidecarForSnapshotLocked(ctx));

    expect(capture.legacyMarkerFlip).toBe(false);
    expect(capture.descriptor.sha256).toBe(sidecarDigest(sidecar));
    expect(capture.bytes).toBe(canonicalJson(sidecar));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// serializeCanonicalSidecar (pure, B4 seam)
// ═════════════════════════════════════════════════════════════════════════════

describe("serializeCanonicalSidecar (#87 B3): pure B4 staging seam", () => {
  it("performs no I/O and sorts features by featureId, matching B1's canonicalSidecar", () => {
    const a = makeFeature({ featureId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const b = makeFeature({ featureId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const result = serializeCanonicalSidecar({ version: 1, features: [a, b] });

    expect(result.canonical.features.map((f) => f.featureId)).toEqual([b.featureId, a.featureId]);
    expect(result.digest).toBe(sidecarDigest({ version: 1, features: [a, b] }));
    expect(result.bytes).toBe(canonicalJson(result.canonical));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Sidecar-only change vs. source-only change (editorRevision seam, AC7)
// ═════════════════════════════════════════════════════════════════════════════

describe("a sidecar-only change advances editorRevision without touching the source revision (#87 B3 AC7)", () => {
  it("writeSidecarLocked changes editorRevision(sourceRevision, sidecarDigest) but computeSourceRevision stays the same", async () => {
    await seedProjectManifest({ editor_store_version: 1 });
    const head = null;
    const scad = "cube([1,1,1]);\n";
    const params = {};
    const sourceRevisionBefore = computeSourceRevision(head, scad, params);

    // Establish a REAL (non-null) "before" digest first -- readSidecarLocked
    // reports `missing` (digest: null) until a sidecar has actually been
    // written once, and `editorRevision` is only ever computed from a real
    // digest.
    await withCtx((ctx) => writeSidecarLocked(ctx, { version: 1, features: [] }));
    const before = await withCtx((ctx) => readSidecarLocked(ctx));
    expect(before.status).toBe("ready");
    const editorRevisionBefore = editorRevision(sourceRevisionBefore, (before as { digest: string }).digest);

    await withCtx((ctx) => writeSidecarLocked(ctx, { version: 1, features: [makeFeature()] }));

    const sourceRevisionAfter = computeSourceRevision(head, scad, params);
    const after = await withCtx((ctx) => readSidecarLocked(ctx));
    expect(after.status).toBe("ready");
    const editorRevisionAfter = editorRevision(sourceRevisionAfter, (after as { digest: string }).digest);

    expect(sourceRevisionAfter).toBe(sourceRevisionBefore); // source untouched by a sidecar-only write
    expect(editorRevisionAfter).not.toBe(editorRevisionBefore); // editor revision moved
  });
});
