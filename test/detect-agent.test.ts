import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getAgentType,
  detectAgent,
  isRunningInAgent,
  getAgentName,
} from "../vendor/skills/src/detect-agent.ts";

/**
 * Guards the @vercel/detect-agent 1.x adapter. determineAgent() returns an
 * `AgentResult` discriminated union; detectAgent() must surface
 * { isAgent, agent.name }. Before the fix, isAgent was always undefined, so
 * agent auto-detection silently never fired. Importing this module also keeps
 * detect-agent.ts in the typecheck graph.
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

// Every env signal @vercel/detect-agent inspects. Cleared so detection is
// deterministic even when this suite itself runs inside an agent (e.g. AI_AGENT
// is set under Claude Code and would otherwise win).
const AGENT_ENV_SIGNALS = [
  "AI_AGENT",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "CODEX_CI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_MODEL",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "OPENCODE_CLIENT",
  "REPL_ID",
];

// detectAgent() delegates to determineAgent() and caches the first result, so this
// asserts a single detection scenario: with every other signal cleared and
// CLAUDE_CODE set, the result must surface isAgent=true and map to claude-code.
test("detectAgent: surfaces a detected agent and wires the projections", async () => {
  // node --test runs all files in one process, so snapshot and restore every
  // env key we touch to avoid leaking mutations into other suites.
  const saved = new Map<string, string | undefined>();
  for (const key of [...AGENT_ENV_SIGNALS, "CLAUDE_CODE"]) {
    saved.set(key, process.env[key]);
  }

  try {
    for (const key of AGENT_ENV_SIGNALS) delete process.env[key];
    process.env.CLAUDE_CODE = "1";

    const result = await detectAgent();
    assert.ok(result.isAgent); // narrows the AgentResult discriminated union
    assert.equal(result.agent.name, "claude");
    assert.equal(await isRunningInAgent(), true);
    assert.equal(await getAgentName(), "claude");
    assert.equal(getAgentType(result.agent.name), "claude-code");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
