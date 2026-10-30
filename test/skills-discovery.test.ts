import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills } from "../vendor/skills/src/skills.ts";
import { tmp } from "./helpers.ts";

test("full-depth discovery preserves distinct same-name skills once per location", async () => {
  const project = tmp();
  try {
    for (const folder of ["primary", "mirror"]) {
      const dir = join(project, "skills", folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"),
        "---\nname: shared-name\ndescription: Relocation fixture\n---\n");
    }
    const skills = await discoverSkills(project, undefined, {
      fullDepth: true,
      includeDuplicateNames: true,
    });
    assert.equal(skills.length, 2);
    assert.equal(new Set(skills.map((skill) => skill.path)).size, 2);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
