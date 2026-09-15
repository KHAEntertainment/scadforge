// SPDX-License-Identifier: Apache-2.0
//
// S3-B ticket B6 (Issue #98): `createSnapshotLocked`'s additive
// `CreateSnapshotOptions` argument (Tech Lead ruling on the
// atomic-sidecar-plus-snapshot gap, generalized by the F1 fault-matrix fix,
// PR #103, to stand alone from any operation-claim/receipt concern). Kept
// in its own file, separate from `store.test.ts`'s pre-existing tests and
// `transaction.test.ts`'s own suite — this exercises the NEW third argument
// specifically, against a hand-built project skeleton (mirrors
// `transaction.test.ts`'s own isolation convention).
//
// SnapshotOrigin (Tech Lead ruling, PR #105, merged): the frozen protocol's
// SnapshotOrigin now includes "editor" -- editor commits stage with that
// literal, named here for the same reason apps/server's scad-core-impl.ts
// names its own copy.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditorFeature, EditorReceipt, EditorSidecar, ProjectManifest, SnapshotOrigin } from "@scadforge/protocol";
import { canonicalJson, canonicalSidecar, sidecarDigest } from "../editor/canonical.js";
import { EMPTY_SIDECAR } from "../editor/sidecar-empty.js";
import { lookupClaimLocked, reserveClaimLocked } from "./claims.js";
import {
  historyDir,
  metaDir,
  projectFilePath,
  quarantineDir,
  rootModelPath,
  rootParamsPath,
  sidecarPath,
  snapshotDir,
  transactionsDir
} from "./paths.js";
import { withRecoveredProject } from "./recovered.js";
import type { LockedProject } from "./recovered.js";
import { createSnapshotLocked } from "./store.js";
import { __setFaultActionForTests } from "./transaction.js";

const EDITOR_SNAPSHOT_ORIGIN: SnapshotOrigin = "editor";

const PROVIDER = { provider: "claude-agent-sdk", model: null, max_passes: 2 };
const PROJECT_ID = "hinged-box";
const BASE_REVISION = "a".repeat(64);
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const FEATURE_ID = "44444444-4444-4444-8444-444444444444";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "scadcore-store-editor-ext-test-"));
  await mkdir(metaDir(projectDir), { recursive: true });
  await mkdir(historyDir(projectDir), { recursive: true });
  const manifest: ProjectManifest = {
    schema_version: 1,
    id: PROJECT_ID,
    name: "Test",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    openscad_image: "openscad/openscad@sha256:test",
    openscad_version: "2026.01.19",
    provider: PROVIDER,
    head: null,
    editor_store_version: 1
  };
  await writeFile(projectFilePath(projectDir), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(rootModelPath(projectDir), "cube(1);\n", "utf8");
  await writeFile(rootParamsPath(projectDir), JSON.stringify({ fileFormatVersion: "1", parameterSets: { current: { wall: 2 } } }, null, 2), "utf8");
  await writeFile(sidecarPath(projectDir), canonicalJson(EMPTY_SIDECAR), "utf8");
});

afterEach(async () => {
  __setFaultActionForTests(null);
  delete process.env.SCADFORGE_FAULT_POINT;
  await rm(projectDir, { recursive: true, force: true });
});

function withCtx<T>(fn: (ctx: LockedProject) => Promise<T>): Promise<T> {
  return withRecoveredProject(projectDir, fn);
}

function fixtureFeature(overrides: Partial<EditorFeature> = {}): EditorFeature {
  return {
    featureId: FEATURE_ID,
    label: "Wall thickness",
    projectId: PROJECT_ID,
    createdAtRevision: BASE_REVISION,
    sourceFingerprint: "b".repeat(64),
    bindingVersion: 1,
    provenance: { kind: "manual" },
    binding: { kind: "linear", parameter: "wall", axis: "x", mapping: { scale: 1, offset: 0, anchor: "min" } },
    ...overrides
  };
}

function fixtureReceiptBuilder(operationId: string, requestDigest: string, values: Record<string, number>) {
  return (facts: { snapshotId: string; sourceRevision: string; sidecarDigest: string; editorRevision: string }): EditorReceipt => ({
    version: 1,
    projectId: PROJECT_ID,
    operationId,
    requestDigest,
    baseEditorRevision: BASE_REVISION,
    editorRevision: facts.editorRevision,
    snapshotId: facts.snapshotId,
    values,
    sidecarDigest: facts.sidecarDigest
  });
}

describe("createSnapshotLocked's editor extension (S3-B ticket B6)", () => {
  it("a put-feature commit stages the snapshot, root sidecar, root params, project.json and receipt in ONE transaction; the claim materializes with the receipt and the before/after record", async () => {
    await withCtx(async (ctx) => {
      await reserveClaimLocked(ctx, OPERATION_ID, "d".repeat(64), { fake: "request" });

      const feature = fixtureFeature();
      const newSidecar: EditorSidecar = { version: 1, features: [feature] };
      const expectedSidecarDigest = sidecarDigest(canonicalSidecar(newSidecar));

      let capturedReceipt: EditorReceipt | undefined;
      const manifest = await createSnapshotLocked(
        ctx,
        { content: "cube(1);\n", params: { wall: 2 }, message: "Created Wall thickness (setup)", origin: EDITOR_SNAPSHOT_ORIGIN, pass: null },
        {
          sidecar: newSidecar,
          editor: {
            claim: { operationId: OPERATION_ID },
            accepted: { kind: "put-feature", featureId: feature.featureId, before: null, after: feature },
            buildReceipt: (facts) => {
              capturedReceipt = fixtureReceiptBuilder(OPERATION_ID, "d".repeat(64), { wall: 2 })(facts);
              return capturedReceipt;
            }
          }
        }
      );

      // The snapshot's OWN captured sidecar digest is B1's real canonical
      // digest of the sidecar this call supplied -- not a tautological
      // self-check against the caller's own facts.
      expect(manifest.editor).toBeDefined();
      expect(manifest.editor!.sha256).toBe(expectedSidecarDigest);
      expect(capturedReceipt!.sidecarDigest).toBe(expectedSidecarDigest);

      const snapshotSidecar = JSON.parse(await readFile(join(snapshotDir(projectDir, manifest.id), "editor.json"), "utf8"));
      expect(snapshotSidecar.features).toHaveLength(1);
      expect(snapshotSidecar.features[0].featureId).toBe(FEATURE_ID);

      // Root sidecar was ALSO updated -- not just the snapshot's own copy.
      const rootSidecar = JSON.parse(await readFile(sidecarPath(projectDir), "utf8"));
      expect(rootSidecar.features).toHaveLength(1);

      // Root params updated in the SAME transaction.
      const rootParams = JSON.parse(await readFile(rootParamsPath(projectDir), "utf8"));
      expect(rootParams.parameterSets.current).toEqual({ wall: 2 });

      // project.json head advanced to this snapshot.
      const project = JSON.parse(await readFile(projectFilePath(projectDir), "utf8")) as ProjectManifest;
      expect(project.head).toBe(manifest.id);

      // Exactly one transaction ran and was cleaned up -- no leftover staging.
      const txEntries = await readdir(transactionsDir(projectDir)).catch(() => []);
      expect(txEntries).toEqual([]);

      // The claim materialized as committed, with the exact receipt and the
      // before/after record this commit produced.
      const looked = await lookupClaimLocked(ctx, OPERATION_ID);
      expect(looked).toEqual({
        kind: "committed",
        receipt: capturedReceipt,
        accepted: { kind: "put-feature", featureId: feature.featureId, before: null, after: feature }
      });
    });
  });

  it("a legacy-empty project's first put-feature flips editor_store_version to 1 in the SAME transaction", async () => {
    // Overwrite the beforeEach's modern manifest with a legacy one (no marker).
    const legacyManifest: ProjectManifest = {
      schema_version: 1,
      id: PROJECT_ID,
      name: "Test",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      openscad_image: "openscad/openscad@sha256:test",
      openscad_version: "2026.01.19",
      provider: PROVIDER,
      head: null
    };
    await writeFile(projectFilePath(projectDir), JSON.stringify(legacyManifest, null, 2), "utf8");

    await withCtx(async (ctx) => {
      await reserveClaimLocked(ctx, OPERATION_ID, "d".repeat(64), { fake: "request" });
      const feature = fixtureFeature();
      const newSidecar: EditorSidecar = { version: 1, features: [feature] };

      await createSnapshotLocked(
        ctx,
        { content: "cube(1);\n", params: { wall: 2 }, message: "Created Wall thickness (setup)", origin: EDITOR_SNAPSHOT_ORIGIN, pass: null },
        {
          sidecar: newSidecar,
          markerFlip: true,
          editor: {
            claim: { operationId: OPERATION_ID },
            accepted: { kind: "put-feature", featureId: feature.featureId, before: null, after: feature },
            buildReceipt: fixtureReceiptBuilder(OPERATION_ID, "d".repeat(64), { wall: 2 })
          }
        }
      );

      const project = JSON.parse(await readFile(projectFilePath(projectDir), "utf8")) as ProjectManifest;
      expect(project.editor_store_version).toBe(1);

      // The end-to-end guarantee `sidecar.test.ts`'s pure-read unit test
      // cannot cover itself (Tech Lead note on Issue #98 F1): the root
      // sidecar genuinely EXISTS on disk, with the new feature, after this
      // transaction publishes.
      const rootSidecar = JSON.parse(await readFile(sidecarPath(projectDir), "utf8"));
      expect(rootSidecar.features).toHaveLength(1);
      expect(rootSidecar.features[0].featureId).toBe(FEATURE_ID);
    });
  });

  it("a fault after staging but before commit.json (editor extension active) leaves the root sidecar untouched, no partial history entry, and the claim aborted", async () => {
    const originalRootSidecar = await readFile(sidecarPath(projectDir), "utf8");

    await withCtx(async (ctx) => {
      await reserveClaimLocked(ctx, OPERATION_ID, "d".repeat(64), { fake: "request" });
      const feature = fixtureFeature();
      const newSidecar: EditorSidecar = { version: 1, features: [feature] };

      __setFaultActionForTests(() => {
        throw new Error("simulated crash: after-full-staging");
      });
      process.env.SCADFORGE_FAULT_POINT = "after-full-staging";

      await expect(
        createSnapshotLocked(
          ctx,
          { content: "cube(1);\n", params: { wall: 2 }, message: "Created Wall thickness (setup)", origin: EDITOR_SNAPSHOT_ORIGIN, pass: null },
          {
            sidecar: newSidecar,
            editor: {
              claim: { operationId: OPERATION_ID },
              accepted: { kind: "put-feature", featureId: feature.featureId, before: null, after: feature },
              buildReceipt: fixtureReceiptBuilder(OPERATION_ID, "d".repeat(64), { wall: 2 })
            }
          }
        )
      ).rejects.toThrow("simulated crash: after-full-staging");

      delete process.env.SCADFORGE_FAULT_POINT;

      // Root sidecar completely untouched.
      expect(await readFile(sidecarPath(projectDir), "utf8")).toBe(originalRootSidecar);
      // No partial history entry -- "0001" was never published.
      const historyEntries = await readdir(historyDir(projectDir)).catch(() => []);
      expect(historyEntries).toEqual([]);
      // Staging was quarantined, never left in editor-transactions/.
      const txEntries = await readdir(transactionsDir(projectDir)).catch(() => []);
      expect(txEntries).toEqual([]);
      const quarantineEntries = await readdir(quarantineDir(projectDir)).catch(() => []);
      expect(quarantineEntries.length).toBeGreaterThan(0);
    });

    // A fresh boundary entry (the "next entry" the ticket describes) confirms
    // the claim is stably aborted, whether the synchronous self-heal above or
    // this fresh recovery pass is what actually resolved it.
    await withCtx(async (ctx) => {
      const looked = await lookupClaimLocked(ctx, OPERATION_ID);
      expect(looked).toEqual({ kind: "definitely_not_committed", requestDigest: "d".repeat(64), reason: "aborted", error: null });
    });
  });
});
