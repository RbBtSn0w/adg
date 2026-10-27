import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initTestGitRepo, tmp } from "./helpers.ts";
import { spawnAdg } from "./sandbox-helpers.mjs";

test("skills add --json emits one JSON value and installs locally through ADG", () => {
  const project = tmp();
  try {
    const source = join(project, "source");
    mkdirSync(source);
    writeFileSync(join(source, "SKILL.md"),
      "---\nname: json-fixture\ndescription: JSON install fixture\n---\n\n# Fixture\n");
    const { result } = spawnAdg(["skills", "add", source,
      "--json", "-y", "--agent", "codex"], {
      cwd: project,
      isolationRoot: join(project, "isolation"),
      env: { DISABLE_TELEMETRY: "1" },
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\x1b\[/);
    const output = JSON.parse(result.stdout);
    assert.ok(Array.isArray(output));
    assert.equal(output.length, 1);
    assert.match(readFileSync(join(project, ".agents", "skills", "json-fixture", "SKILL.md"),
      "utf8"), /# Fixture/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("remote root skills retain the single-file boundary and skip unchanged updates", () => {
  const project = tmp();
  const source = tmp();
  try {
    initTestGitRepo(source);
    writeFileSync(join(source, "SKILL.md"),
      "---\nname: root-fixture\ndescription: Remote root fixture\n---\n\n# Root\n");
    writeFileSync(join(source, "unrelated.txt"), "Not part of the installed root skill\n");
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "commit", "-qm", "test: add root fixture"]);
    const run = (args: string[]) => spawnAdg(["skills", ...args], {
      cwd: project,
      isolationRoot: join(project, "isolation"),
      env: { DISABLE_TELEMETRY: "1" },
      timeout: 30_000,
    }).result;
    const added = run(["add", pathToFileURL(source).href, "--json", "-y", "--agent", "codex"]);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(existsSync(join(project, ".agents", "skills", "root-fixture", "unrelated.txt")), false);

    const updated = run(["update", "--project", "-y"]);
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /All project skills are up to date/);
    assert.doesNotMatch(updated.stdout, /Updating root-fixture/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
