import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSymlinkTo } from "../src/commands/remove.ts";

/**
 * `remove` detects whether an agent's enabled-plugin entry is the symlink it
 * installed, so it only unlinks its own links. The target must resolve against
 * the link's own directory, not process.cwd(). (Regression: PR #1 review
 * thread, T6 — the old resolve(readlink(...)) against cwd missed relative
 * targets when cwd differed.)
 */

function tmp(prefix = "adg-remove-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSymlinkTo: detects an absolute symlink target", () => {
  const root = tmp();
  try {
    const pluginDir = join(root, "p");
    mkdirSync(pluginDir, { recursive: true });
    const linkPath = join(root, "link");
    symlinkSync(pluginDir, linkPath);

    assert.equal(isSymlinkTo(linkPath, pluginDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isSymlinkTo: a regular file (not a symlink) is rejected", () => {
  const root = tmp();
  try {
    const file = join(root, "real.txt");
    writeFileSync(file, "x");
    assert.equal(isSymlinkTo(file, file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
