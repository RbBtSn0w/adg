import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { fileMemberName } from "../src/components.ts";

/**
 * Member names are derived with an OS-aware basename so a component file maps to
 * its bare id on every platform.
 */

// (Regression: PR #1 review thread, T5 — the old `abs.split("/").pop()` returned
// the whole path on Windows, where join() produces backslashes.)
test("fileMemberName: strips directory and extension on POSIX paths", () => {
  assert.equal(fileMemberName("/plugin/agents/release.md", path.posix.basename), "release");
});

test("fileMemberName: strips Windows backslash directories (regression for split('/'))", () => {
  assert.equal(
    fileMemberName("C:\\plugin\\agents\\release.md", path.win32.basename),
    "release"
  );
  assert.equal(fileMemberName("C:\\plugin\\commands\\do.ts", path.win32.basename), "do");
});

test("fileMemberName: a name without extension is returned as-is", () => {
  assert.equal(fileMemberName("/a/b/LICENSE", path.posix.basename), "LICENSE");
});
