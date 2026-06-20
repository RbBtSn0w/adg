import { test } from "node:test";
import assert from "node:assert/strict";

import { agentsForComponents } from "../src/agents/index.ts";

/**
 * `adg plugins list` derives its "Agents:" column from a plugin's exposed
 * component types: an agent is listed when its adapter can express at least one
 * of those types. Codex only consumes skills, while Claude and Antigravity (agy)
 * also take agents/commands/hooks/mcp — so the derivation must split on
 * component type.
 */

const ids = (types: Parameters<typeof agentsForComponents>[0]) => agentsForComponents(types).map((a) => a.id).sort();

test("a skills-only plugin is adaptable to every agent", () => {
  assert.deepEqual(ids(["skills"]), ["antigravity", "claude", "codex"]);
});

test("a Claude-only component type also includes Antigravity, but not Codex", () => {
  assert.deepEqual(ids(["commands"]), ["antigravity", "claude"]);
  assert.deepEqual(ids(["agents"]), ["antigravity", "claude"]);
  assert.deepEqual(ids(["hooks"]), ["antigravity", "claude"]);
  assert.deepEqual(ids(["mcp"]), ["antigravity", "claude"]);
});

test("mixing skills with a Claude-only type still includes Codex", () => {
  assert.deepEqual(ids(["skills", "commands"]), ["antigravity", "claude", "codex"]);
});

test("no exposed components (no manifest) can't be proven incompatible — all agents", () => {
  assert.deepEqual(ids([]), ["antigravity", "claude", "codex"]);
});
