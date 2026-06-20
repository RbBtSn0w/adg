import { test } from "node:test";
import assert from "node:assert/strict";

import { skillsChildArgv } from "../bin/adg.ts";
import { selfCliArgv } from "../vendor/skills/src/self-cli.ts";

/**
 * Re-invoking a `.ts` entry under Node must forward `process.execArgv` so the
 * child inherits flags like --experimental-strip-types (required to run TS
 * directly on Node 22.6–23.5). Two entry points do this re-invocation — the
 * `adg skills` bridge (skillsChildArgv) and the skills self-update
 * (selfCliArgv) — and both must place execArgv before the entry and its args.
 * (Regression: PR #1 review thread, commit bdd5d6c, T1–T3.)
 */

test("skillsChildArgv: prepends execArgv before the entry and args", () => {
  assert.deepEqual(
    skillsChildArgv("/x/cli.ts", ["add", "foo"], ["--experimental-strip-types"]),
    ["--experimental-strip-types", "/x/cli.ts", "add", "foo"]
  );
});

test("skillsChildArgv: an empty execArgv leaves entry and args first", () => {
  assert.deepEqual(skillsChildArgv("/x/cli.ts", ["list"], []), ["/x/cli.ts", "list"]);
});

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
