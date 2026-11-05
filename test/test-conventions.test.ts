import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Tests are named after the module/behavior under test, never after the PR or
 * commit that happened to introduce them (those names lose all meaning over
 * time and scatter a module's coverage across files). Regression cases live in
 * the relevant behavior file, tagged with a `// (Regression: ...)` comment.
 * (TD-1.) This guard fails CI if a PR/commit-scoped filename creeps back in.
 */
test("no test file is named after a PR or commit", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const banned = /(^|[-_])(pr\d+|cr-fix|cr-fixes|commit|hotfix|issue\d+)([-_.]|$)/i;
  // Recurse: the runner globs test/**/*.test.ts, so a PR-scoped file in a
  // subdirectory would still run — match the same breadth here. Compare on the
  // basename so directory names never trip the filename rule.
  const offenders = readdirSync(here, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f.split(/[\\/]/).pop()!)
    .filter((f) => banned.test(f));
  assert.deepEqual(
    offenders,
    [],
    `Rename PR/commit-scoped test file(s) to the module/behavior under test: ${offenders.join(", ")}`,
  );
});

// Generate transport archives from synthetic data in tmpdir; opaque upstream
// snapshots can disclose private source and cannot be reviewed as normal diffs.
test("test fixtures do not contain committed source archives", () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  const archives = readdirSync(fixtures, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(?:tar(?:\.gz)?|tgz|zip)$/i.test(file));
  assert.deepEqual(archives, [], "Generate synthetic archives in a temporary directory instead of committing source snapshots");
});
