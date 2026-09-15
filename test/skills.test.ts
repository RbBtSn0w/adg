import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { isCancel } from "@clack/core";

import { resolveSkills, readSkillDescription, skillDescriptionLoader } from "../src/skills.ts";
import { buildSkillRows, multiselectSkills, type SkillOption } from "../src/commands/multiselect-skills.ts";
import { tmp, baseManifest } from "./helpers.ts";

test("resolveSkills auto-scans only dirs with SKILL.md", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "good"), { recursive: true });
  writeFileSync(join(dir, "skills", "good", "SKILL.md"), "x");
  mkdirSync(join(dir, "skills", "empty"), { recursive: true });
  assert.deepEqual(resolveSkills(dir, baseManifest), ["good"]);
  rmSync(dir, { recursive: true });
});

test("readSkillDescription parses frontmatter, tolerates absence", () => {
  const dir = tmp();
  const md = join(dir, "SKILL.md");
  writeFileSync(md, "---\nname: a\ndescription: Do a thing well\n---\nbody");
  assert.equal(readSkillDescription(md), "Do a thing well");
  writeFileSync(md, "no frontmatter at all");
  assert.equal(readSkillDescription(md), undefined);
  writeFileSync(md, "---\nname: a\n---\nbody");
  assert.equal(readSkillDescription(md), undefined);
  assert.equal(readSkillDescription(join(dir, "missing.md")), undefined);
  rmSync(dir, { recursive: true });
});

test("skillDescriptionLoader is lazy and caches per skill", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  writeFileSync(join(dir, "skills", "alpha", "SKILL.md"), "---\ndescription: Alpha skill\n---\n");
  mkdirSync(join(dir, "skills", "beta"), { recursive: true });
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), "no fm");
  const load = skillDescriptionLoader(dir, baseManifest);
  assert.equal(load("alpha"), "Alpha skill");
  assert.equal(load("beta"), undefined);
  assert.equal(load("ghost"), undefined);
  // Cached: deleting the file after first read still returns the cached value.
  rmSync(join(dir, "skills", "alpha", "SKILL.md"));
  assert.equal(load("alpha"), "Alpha skill");
  rmSync(dir, { recursive: true });
});

test("buildSkillRows resolves descriptions only when toggled on", () => {
  const options: SkillOption[] = [
    { value: "alpha", label: "alpha" },
    { value: "beta", label: "beta" },
  ];
  const calls: string[] = [];
  const loadDescription = (v: string) => {
    calls.push(v);
    return v === "alpha" ? "Alpha desc" : undefined;
  };
  const off = buildSkillRows(options, { cursor: 0, selected: ["alpha"], showDesc: false, loadDescription });
  assert.equal(calls.length, 0, "no SKILL.md reads while descriptions are hidden");
  assert.ok(!off.join("\n").includes("Alpha desc"));

  const on = buildSkillRows(options, { cursor: 0, selected: ["alpha"], showDesc: true, loadDescription });
  assert.deepEqual(calls, ["alpha", "beta"], "reads each option once when shown");
  assert.ok(on.join("\n").includes("Alpha desc"), "renders the resolved description inline");
});

test("multiselectSkills submits selected values on return key without TypeError", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const promise = multiselectSkills({
    message: "which skills?",
    options: [
      { value: "a", label: "Skill A" },
      { value: "b", label: "Skill B" },
    ],
    initialValues: ["a"],
    loadDescription: () => undefined,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });

  input.emit("keypress", "\r", { name: "return" });

  const result = await promise;
  assert.deepEqual(result, ["a"]);
});

test("multiselectSkills enforces required selection when required is true", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputChunks = "";
  output.on("data", (chunk) => {
    outputChunks += chunk.toString();
  });

  const promise = multiselectSkills({
    message: "which skills?",
    options: [
      { value: "a", label: "Skill A" },
      { value: "b", label: "Skill B" },
    ],
    initialValues: [],
    loadDescription: () => undefined,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });

  // Attempt to submit empty selection
  input.emit("keypress", "\r", { name: "return" });

  // Output should show the validation error
  assert.ok(outputChunks.includes("Please select at least one option."));

  // Select all using 'a', then submit
  input.emit("keypress", "a", { name: "a" });
  input.emit("keypress", "\r", { name: "return" });

  const result = await promise;
  assert.deepEqual(result, ["a", "b"]);
});

test("multiselectSkills returns cancel symbol on cancel key", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const promise = multiselectSkills({
    message: "which skills?",
    options: [{ value: "a", label: "Skill A" }],
    initialValues: ["a"],
    loadDescription: () => undefined,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });

  input.emit("keypress", "\x03", { name: "c", ctrl: true });

  const result = await promise;
  assert.ok(isCancel(result));
});
