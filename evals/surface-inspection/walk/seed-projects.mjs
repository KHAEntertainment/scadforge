#!/usr/bin/env node
// S2-6 human walk: seeds the 6 projects the walk runbook (README.md in this
// directory) needs, through the app's real REST API — the same flow the
// app itself uses (POST /api/projects with the source, PUT the params,
// then POST /build so the preview holds a real server render, since
// Inspect only works against the server mesh). Idempotent: skips (reuses)
// any project whose name already exists rather than creating a duplicate.
//
// Requires the server running (see README.md "Starting the app").
//
// Usage: node evals/surface-inspection/walk/seed-projects.mjs
// Env:   SCADFORGE_API_URL (default http://localhost:3001)

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const BASE_URL = process.env.SCADFORGE_API_URL ?? "http://localhost:3001";
const API = `${BASE_URL}/api`;

const CLAMP_SCAD = join(REPO_ROOT, "evals/scenario-a2/fixture/clamp.scad");
const HINGE_SCAD = join(REPO_ROOT, "evals/surface-inspection/fixture/hinge.scad");

// Names match the runbook's table headers exactly — keep the two in sync.
const PROJECTS = [
  { name: "S2 walk · clamp wall2", scadPath: CLAMP_SCAD, params: { wall: 2 } },
  { name: "S2 walk · clamp wall4", scadPath: CLAMP_SCAD, params: { wall: 4 } },
  { name: "S2 walk · clamp wall6", scadPath: CLAMP_SCAD, params: { wall: 6 } },
  { name: "S2 walk · hinge low", scadPath: HINGE_SCAD, params: { pin_d: 3, knuckle_wall: 1.5 } },
  { name: "S2 walk · hinge mid", scadPath: HINGE_SCAD, params: { pin_d: 4.5, knuckle_wall: 2 } },
  { name: "S2 walk · hinge high", scadPath: HINGE_SCAD, params: { pin_d: 6, knuckle_wall: 3.5 } }
];

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function findExisting(name) {
  const { projects } = await api("/projects");
  return projects.find((p) => p.name === name) ?? null;
}

async function seedOne(spec) {
  const existing = await findExisting(spec.name);
  if (existing) {
    console.log(`SKIP (already exists): "${spec.name}" -> ${existing.id}`);
    return { name: spec.name, id: existing.id, created: false };
  }

  const scad = await readFile(spec.scadPath, "utf8");
  const created = await api("/projects", { method: "POST", body: JSON.stringify({ name: spec.name, scad }) });
  const projectId = created.project.id;

  // Sets the sample's params and snapshots them (default `snapshot: true`).
  await api(`/projects/${projectId}/params`, {
    method: "PUT",
    body: JSON.stringify({ values: spec.params, snapshot: true })
  });

  // Build: pins the snapshot and attaches a REAL server render + mesh +
  // validation. Inspect only ever works against that server mesh (S2
  // scope: "Server render is authoritative"), so this step is required —
  // a project with only a params-updated snapshot and no build has no
  // server STL for the preview to show.
  const source = await api(`/projects/${projectId}/source`);
  await api(`/projects/${projectId}/build`, {
    method: "POST",
    body: JSON.stringify({ base_revision: source.revision })
  });

  console.log(`CREATED: "${spec.name}" -> ${projectId}`);
  return { name: spec.name, id: projectId, created: true };
}

async function main() {
  console.log(`Seeding S2 walk projects against ${BASE_URL} ...\n`);
  const results = [];
  for (const spec of PROJECTS) {
    results.push(await seedOne(spec));
  }
  console.log("\nProject names for the walk (open each in the app by name):");
  for (const r of results) {
    console.log(`  ${r.name}  (id: ${r.id}, ${r.created ? "created" : "reused"})`);
  }
}

await main();
