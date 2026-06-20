import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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
  const offenders = readdirSync(here)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => banned.test(f));
  assert.deepEqual(
    offenders,
    [],
    `Rename PR/commit-scoped test file(s) to the module/behavior under test: ${offenders.join(", ")}`,
  );
});
