import { test } from "node:test";
import assert from "node:assert/strict";

import { agentsForComponents } from "../src/agents/index.ts";

/**
 * `adg plugins list` derives its "Agents:" column from a plugin's exposed
 * component types: an agent is listed when its adapter can express at least one
 * of those types. Codex only consumes skills, while Claude also takes
 * agents/commands/hooks/mcp — so the derivation must split on component type.
 */

const ids = (types: Parameters<typeof agentsForComponents>[0]) => agentsForComponents(types).map((a) => a.id).sort();

test("a skills-only plugin is adaptable to both Claude and Codex", () => {
  assert.deepEqual(ids(["skills"]), ["claude", "codex"]);
});

test("a commands-only plugin is adaptable to Claude only (Codex takes skills)", () => {
  assert.deepEqual(ids(["commands"]), ["claude"]);
  assert.deepEqual(ids(["agents"]), ["claude"]);
  assert.deepEqual(ids(["hooks"]), ["claude"]);
  assert.deepEqual(ids(["mcp"]), ["claude"]);
});

test("mixing skills with a Claude-only type still includes Codex", () => {
  assert.deepEqual(ids(["skills", "commands"]), ["claude", "codex"]);
});

test("no exposed components (no manifest) can't be proven incompatible — all agents", () => {
  assert.deepEqual(ids([]), ["claude", "codex"]);
});
