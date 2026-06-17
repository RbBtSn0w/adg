import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { skillsChildArgv } from "../bin/adg.ts";
import { selfCliArgv } from "../vendor/skills/src/update.ts";
import { fileMemberName } from "../src/components.ts";
import { isSymlinkTo } from "../src/commands/remove.ts";

/**
 * Regression tests for the PR #1 review-thread fixes (commit bdd5d6c):
 * T1–T3 process.execArgv forwarding, T5 Windows-safe member names, T6 relative
 * symlink resolution.
 */

function tmp(prefix = "adg-pr1-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- T1: bin/adg.ts forwards process.execArgv to the skills child ----

test("skillsChildArgv: prepends execArgv before the entry and args", () => {
  assert.deepEqual(
    skillsChildArgv("/x/cli.ts", ["add", "foo"], ["--experimental-strip-types"]),
    ["--experimental-strip-types", "/x/cli.ts", "add", "foo"]
  );
});

test("skillsChildArgv: an empty execArgv leaves entry and args first", () => {
  assert.deepEqual(skillsChildArgv("/x/cli.ts", ["list"], []), ["/x/cli.ts", "list"]);
});

// ---- T2/T3: vendor/skills/src/update.ts forwards execArgv to the self-CLI ----

test("selfCliArgv: forwards execArgv for the global-update invocation", () => {
  assert.deepEqual(
    selfCliArgv("/c/cli.ts", ["add", "url", "-g", "-y"], ["--experimental-strip-types"]),
    ["--experimental-strip-types", "/c/cli.ts", "add", "url", "-g", "-y"]
  );
});

test("selfCliArgv: forwards multiple Node flags for the project-update invocation", () => {
  assert.deepEqual(
    selfCliArgv("/c/cli.ts", ["add", "url", "--skill", "s", "-y"], ["--a", "--b"]),
    ["--a", "--b", "/c/cli.ts", "add", "url", "--skill", "s", "-y"]
  );
});

test("selfCliArgv: empty execArgv keeps the cli entry first", () => {
  assert.deepEqual(selfCliArgv("/c/cli.ts", ["add", "url", "-g", "-y"], []), [
    "/c/cli.ts",
    "add",
    "url",
    "-g",
    "-y",
  ]);
});

// ---- T5: components.ts derives member names with OS-aware basename ----

test("fileMemberName: strips directory and extension on POSIX paths", () => {
  assert.equal(fileMemberName("/plugin/agents/release.md", path.posix.basename), "release");
});

test("fileMemberName: strips Windows backslash directories (regression for split('/'))", () => {
  // The old `abs.split("/").pop()` returned the whole path on Windows, where
  // join() produces backslashes. basename(win32) must strip them.
  assert.equal(
    fileMemberName("C:\\plugin\\agents\\release.md", path.win32.basename),
    "release"
  );
  assert.equal(fileMemberName("C:\\plugin\\commands\\do.ts", path.win32.basename), "do");
});

test("fileMemberName: a name without extension is returned as-is", () => {
  assert.equal(fileMemberName("/a/b/LICENSE", path.posix.basename), "LICENSE");
});

// ---- T6: remove.ts resolves relative symlink targets against the link dir ----

test("isSymlinkTo: detects a relative symlink regardless of process cwd", () => {
  const root = tmp();
  const pluginDir = join(root, "myplugin");
  mkdirSync(pluginDir, { recursive: true });
  const linkDir = join(root, "skills");
  mkdirSync(linkDir, { recursive: true });

  const linkPath = join(linkDir, "myplugin");
  // Relative target pointing at ../myplugin from the link's own directory.
  symlinkSync(join("..", "myplugin"), linkPath);

  const originalCwd = process.cwd();
  try {
    // Force a cwd that is NOT the link's parent — the old resolve(readlink(...))
    // against process.cwd() would have failed to match here.
    process.chdir(tmpdir());
    assert.equal(isSymlinkTo(linkPath, pluginDir), true);
    assert.equal(isSymlinkTo(linkPath, join(root, "other")), false);
  } finally {
    process.chdir(originalCwd);
  }
});

test("isSymlinkTo: detects an absolute symlink target", () => {
  const root = tmp();
  const pluginDir = join(root, "p");
  mkdirSync(pluginDir, { recursive: true });
  const linkPath = join(root, "link");
  symlinkSync(pluginDir, linkPath);

  assert.equal(isSymlinkTo(linkPath, pluginDir), true);
});

test("isSymlinkTo: a regular file (not a symlink) is rejected", () => {
  const root = tmp();
  const file = join(root, "real.txt");
  writeFileSync(file, "x");
  assert.equal(isSymlinkTo(file, file), false);
});
