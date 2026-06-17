import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getAgentType,
  detectAgent,
  isRunningInAgent,
  getAgentName,
} from "../vendor/skills/src/detect-agent.ts";

/**
 * Guards the @vercel/detect-agent@0.1.0 adapter. determineAgent() returns a
 * string|false; detectAgent() must surface { isAgent, agent.name }. Before the
 * fix, isAgent was always undefined, so agent auto-detection silently never
 * fired. Importing this module also keeps detect-agent.ts in the typecheck graph.
 */

// getAgentType is pure — independent of detection state and the module cache.
test("getAgentType: maps known detect-agent names to skills AgentTypes", () => {
  assert.equal(getAgentType("cursor"), "cursor");
  assert.equal(getAgentType("claude"), "claude-code");
  assert.equal(getAgentType("devin"), "universal");
  assert.equal(getAgentType("replit"), "replit");
});

test("getAgentType: unknown names map to null", () => {
  assert.equal(getAgentType("totally-unknown-agent"), null);
});

// determineAgent() reads CLAUDE_CODE; clear the other signals so the detected
// name is deterministic. The module caches the first result, so this asserts the
// single detection scenario.
test("detectAgent: adapts a detected agent (CLAUDE_CODE) into the AgentResult shape", async () => {
  delete process.env.CURSOR_TRACE_ID;
  delete process.env.REPL_ID;
  process.env.CLAUDE_CODE = "1";

  const result = await detectAgent();
  assert.equal(result.isAgent, true);
  assert.equal(result.agent.name, "claude");
  assert.equal(await isRunningInAgent(), true);
  assert.equal(await getAgentName(), "claude");
  assert.equal(getAgentType(result.agent.name), "claude-code");
});
