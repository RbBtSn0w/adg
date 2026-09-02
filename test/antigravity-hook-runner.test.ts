import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { TOOL_ALIASES } from "../src/adapters/antigravity-hooks.ts";
import { claudeToolName } from "../src/adapters/antigravity-hook-runner.mjs";

const RUNNER_PATH = new URL("../src/adapters/antigravity-hook-runner.mjs", import.meta.url).pathname;

// Regression guard for the drift the issue describes: `claudeToolName` in
// antigravity-hook-runner.mjs is a hand-inverted copy of TOOL_ALIASES (it has
// to be a literal — the runner executes as a standalone child process with no
// import access to the TS module). Assert the two tables stay exact inverses
// of each other so a change to one can't silently desync the other.
test("claudeToolName is the exact inverse of TOOL_ALIASES", () => {
  const expectedPairs: Array<[string, string]> = Object.entries(TOOL_ALIASES).flatMap(
    ([claudeName, antigravityNames]) => antigravityNames.split("|").map((agyName): [string, string] => [agyName, claudeName]),
  );
  for (const [agyName, claudeName] of expectedPairs) {
    assert.equal(claudeToolName(agyName), claudeName, `claudeToolName(${agyName}) should map back to ${claudeName}`);
  }
  // No duplicate Antigravity names: TOOL_ALIASES must not map two different
  // Claude tools to the same "|"-joined Antigravity name, or the inverse
  // mapping in claudeToolName would be ambiguous.
  const known = new Set(expectedPairs.map(([agyName]) => agyName));
  assert.equal(known.size, expectedPairs.length, "TOOL_ALIASES must not map two Claude tools to the same Antigravity name");
});

test("claudeToolName passes through an unrecognized name unchanged", () => {
  assert.equal(claudeToolName("some_future_antigravity_tool"), "some_future_antigravity_tool");
});

// Regression guard: the entry-point guard used to call realpathSync(process.argv[1])
// unconditionally. Under `node -e "<code>" <arg>`, argv[1] is that literal
// trailing arg, not a real path — realpathSync throws ENOENT for it, turning
// a safe import into a crash. Reproduce that exact invocation mode (a `-e`
// with a non-path positional, e.g. `node -e "<code>" not-a-real-file`) rather
// than unit-testing the guard in isolation, since the bug is specifically
// about how Node populates argv[1] here.
test("importing the runner under `node -e` with a non-path argv[1] does not throw", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(pathToFileURL(RUNNER_PATH).href)}).then((m) => { if (typeof m.claudeToolName !== "function") throw new Error("claudeToolName missing"); });`,
      "not-a-real-file",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
