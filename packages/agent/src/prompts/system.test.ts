// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWS, OPENSCAD_VERSION } from "@scadforge/scad-core";
import { TOOL_NAMES, DEFAULT_MAX_PASSES } from "../tools/contract.js";
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "./system.js";
import { buildTurnPrompt } from "./turn.js";
import { containsFencedCodeBlock } from "../sanitize.js";

describe("buildSystemPrompt — Issue #16 AC checklist", () => {
  const prompt = DEFAULT_SYSTEM_PROMPT;

  it("names every one of the seven tools", () => {
    for (const name of TOOL_NAMES) expect(prompt).toContain(name);
  });

  it("covers OpenSCAD idioms", () => {
    expect(prompt).toMatch(/union\(\)|hull\(\)|difference\(\)/);
    expect(prompt).toMatch(/linear_extrude|rotate_extrude/);
    expect(prompt).toMatch(/overhang/i);
  });

  it("covers Customizer syntax", () => {
    expect(prompt).toContain("[Main]");
    expect(prompt).toContain("[min:max]");
    expect(prompt).toContain("[min:step:max]");
    expect(prompt).toMatch(/dropdown/i);
  });

  it("mandates params-first structure", () => {
    expect(prompt).toMatch(/parameters first, helper modules second, geometry last/i);
  });

  it("mandates mm units", () => {
    expect(prompt).toMatch(/MILLIMETRES/);
    expect(prompt).toMatch(/Never centimetres, never inches/i);
  });

  it("imposes $fn discipline with a ceiling", () => {
    expect(prompt).toContain("$fn");
    expect(prompt).toMatch(/Never exceed 128/i);
    expect(prompt).toMatch(/coarse/i);
  });

  it("requires inspecting renders before declaring done", () => {
    expect(prompt).toMatch(/Never say a model is finished without having looked at a render/i);
    expect(prompt).toContain(DEFAULT_VIEWS.join(", "));
    expect(prompt).toMatch(/section/);
  });

  it("makes validation warnings blocking", () => {
    expect(prompt).toMatch(/VALIDATION IS BLOCKING/);
    expect(prompt).toMatch(/every warning as blocking/i);
    expect(prompt).toMatch(/components > 1/);
  });

  it("restricts correction passes to defects only", () => {
    expect(prompt).toMatch(/fixes DEFECTS ONLY/);
    expect(prompt).toMatch(/Do not use it to restyle, rename, refactor/i);
    expect(prompt).toMatch(/Stopping early is\s+correct behaviour/);
  });

  it("states the pass budget and the no-code-in-chat output contract", () => {
    expect(prompt).toContain(`${DEFAULT_MAX_PASSES} write_scad calls per turn`);
    expect(prompt).toContain("SCADFORGE_MAX_PASSES");
    expect(prompt).toMatch(/NEVER paste OpenSCAD source into your reply/);
    expect(prompt).toMatch(/Fenced blocks are stripped/);
  });

  it("names the pinned OpenSCAD version", () => {
    expect(prompt).toContain(OPENSCAD_VERSION);
  });

  it("does not itself contain a fenced code block (it would be stripped downstream)", () => {
    expect(containsFencedCodeBlock(prompt)).toBe(false);
  });
});

describe("buildSystemPrompt — options", () => {
  it("interpolates a custom pass budget, singular and plural", () => {
    expect(buildSystemPrompt({ maxPasses: 1 })).toContain("1 write_scad call per turn");
    expect(buildSystemPrompt({ maxPasses: 3 })).toContain("3 write_scad calls per turn");
  });

  it("tells the model when the library index is unavailable", () => {
    const prompt = buildSystemPrompt({ librariesAvailable: false });
    expect(prompt).toMatch(/currently unavailable/);
    expect(prompt).toMatch(/plain OpenSCAD primitives/);
  });

  it("appends project guidance verbatim", () => {
    expect(buildSystemPrompt({ additionalGuidance: "PROJECT: printer is a Bambu A1." })).toContain(
      "PROJECT: printer is a Bambu A1."
    );
  });
});

describe("buildTurnPrompt", () => {
  it("frames a fresh project as a build", () => {
    expect(buildTurnPrompt({ message: "a 20mm bracket" })).toBe("Build this: a 20mm bracket");
  });

  it("tells a turn against an existing model to inspect first", () => {
    const prompt = buildTurnPrompt({ message: "make the wall thicker", hasExistingModel: true });
    expect(prompt).toMatch(/read_project first/);
    expect(prompt).toMatch(/Do not rewrite the model blind/);
    expect(prompt).toContain("make the wall thicker");
  });

  it("rejects an empty message", () => {
    expect(() => buildTurnPrompt({ message: "   " })).toThrow(/must not be empty/);
  });
});
