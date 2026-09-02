import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_ALIASES } from "../src/adapters/antigravity-hooks.ts";
import { claudeToolName } from "../src/adapters/antigravity-hook-runner.mjs";

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
