import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { cleanupTempDir, cloneRepo } from "../vendor/skills/src/git.ts";

test("cloneRepo installs the requested commit while ignoring inherited Git hooks", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "adg-git-pinned-"));
  let clonedDir: string | undefined;
  const previousAskPass = process.env.GIT_ASKPASS;
  const git = (args: string[]) => execFileSync("git", ["-C", sourceDir, ...args], {
    encoding: "utf8",
  }).trim();
  const commit = () => {
    git(["add", "SKILL.md"]);
    git(["-c", "user.name=ADG Test", "-c", "user.email=adg@example.invalid",
      "commit", "--quiet", "-m", "test: update fixture"]);
    return git(["rev-parse", "HEAD"]);
  };

  try {
    git(["init", "--quiet"]);
    await writeFile(join(sourceDir, "SKILL.md"), "# Pinned version\n");
    const pinned = commit();
    await writeFile(join(sourceDir, "SKILL.md"), "# Latest version\n");
    commit();
    process.env.GIT_ASKPASS = "/nonexistent/adg-askpass";

    clonedDir = await cloneRepo(pathToFileURL(sourceDir).href, pinned);

    assert.equal(await readFile(join(clonedDir, "SKILL.md"), "utf8"), "# Pinned version\n");
    assert.equal(execFileSync("git", ["-C", clonedDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(), pinned);
  } finally {
    if (previousAskPass === undefined) delete process.env.GIT_ASKPASS;
    else process.env.GIT_ASKPASS = previousAskPass;
    if (clonedDir) await cleanupTempDir(clonedDir);
    await rm(sourceDir, { recursive: true, force: true });
  }
});

/**
 * Test Intent
 * Risk: inherited Git hooks or config injection prevent anonymous clones or execute unsafe helpers.
 * Why Automation: a normal local clone does not exercise mixed-case hooks or config injection.
 * Why Existing Tests Insufficient: no test covers the environment passed to the vendored git client.
 * Chosen Layer: Integration Test - clone a local repository through the real git client without network access.
 * Fragility Analysis: normalize platform checkout line endings, then assert the cloned content.
 * If Omitted: dependency security hardening can regress the primary skill installation path.
 */
test("cloneRepo ignores inherited Git hooks and config injection", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "adg-git-source-"));
  let clonedDir: string | undefined;
  const previousGitAskPass = process.env.GIT_ASKPASS;
  const previousMixedCaseGitAskPass = process.env.Git_AskPass;
  const previousSshAskPass = process.env.SSH_ASKPASS;
  const previousGitConfigParameters = process.env.GIT_CONFIG_PARAMETERS;

  try {
    await writeFile(join(sourceDir, "SKILL.md"), "# Fixture\n", "utf8");
    execFileSync("git", ["init", "--quiet", sourceDir]);
    execFileSync("git", ["-C", sourceDir, "add", "SKILL.md"]);
    execFileSync("git", [
      "-C",
      sourceDir,
      "-c",
      "user.name=ADG Test",
      "-c",
      "user.email=adg@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: add fixture",
    ]);

    delete process.env.GIT_ASKPASS;
    process.env.Git_AskPass = "/nonexistent/adg-askpass";
    process.env.SSH_ASKPASS = "/nonexistent/adg-ssh-askpass";
    process.env.GIT_CONFIG_PARAMETERS = "invalid";

    clonedDir = await cloneRepo(sourceDir);

    const clonedSkill = await readFile(join(clonedDir, "SKILL.md"), "utf8");
    assert.equal(clonedSkill.replaceAll("\r\n", "\n"), "# Fixture\n");
  } finally {
    delete process.env.GIT_ASKPASS;
    delete process.env.Git_AskPass;
    if (previousGitAskPass !== undefined) process.env.GIT_ASKPASS = previousGitAskPass;
    if (previousMixedCaseGitAskPass !== undefined) {
      process.env.Git_AskPass = previousMixedCaseGitAskPass;
    }
    if (previousSshAskPass === undefined) delete process.env.SSH_ASKPASS;
    else process.env.SSH_ASKPASS = previousSshAskPass;
    if (previousGitConfigParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = previousGitConfigParameters;
    if (clonedDir) await cleanupTempDir(clonedDir);
    await rm(sourceDir, { recursive: true, force: true });
  }
});
