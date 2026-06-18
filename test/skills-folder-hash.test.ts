import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { gitTreeShaForFolder } from "../vendor/skills/src/git-tree.ts";

/**
 * Guards the plan-A fix (see vendor/skills/PROVENANCE.md, docs/agents-spec.md): when a
 * github skill source falls back to a git clone at install time, the recorded
 * folder hash must be the git *tree object SHA* — the exact value GitHub's Trees
 * API (and `getSkillFolderHashFromTree`) returns at update time. If these two
 * ever diverge again, every update perpetually re-flags the whole repo.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "adg-treehash-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, "skill-x"), { recursive: true });
  writeFileSync(join(repo, "skill-x", "SKILL.md"), "# skill x\n");
  writeFileSync(join(repo, "root.md"), "root\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

test("gitTreeShaForFolder matches the GitHub tree-API folder SHA (`git ls-tree`)", async () => {
  const repo = makeRepo();
  try {
    // `git ls-tree HEAD skill-x` → "<mode> tree <sha>\tskill-x" — the <sha> here
    // is exactly what GitHub's Trees API reports for that folder entry.
    const lsLine = git(repo, ["ls-tree", "HEAD", "skill-x"]);
    const expected = lsLine.split(/\s+/)[2];
    const actual = await gitTreeShaForFolder(repo, "skill-x");
    assert.match(actual ?? "", /^[0-9a-f]{40}$/);
    assert.equal(actual, expected, "clone-fallback hash must equal the tree-API folder SHA");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitTreeShaForFolder('') returns the repo root tree SHA", async () => {
  const repo = makeRepo();
  try {
    const expected = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const actual = await gitTreeShaForFolder(repo, "");
    assert.equal(actual, expected);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitTreeShaForFolder returns null for a missing folder", async () => {
  const repo = makeRepo();
  try {
    assert.equal(await gitTreeShaForFolder(repo, "does-not-exist"), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
