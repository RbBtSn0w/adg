import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allAgents, detectedAgents, getAgent } from "../src/agents/index.ts";

/**
 * The `adg plugins add` interactive flow pre-selects the agents present on the
 * machine. Detection keys off CODEX_HOME / CLAUDE_CONFIG_DIR / GEMINI_HOME so the
 * prompt reflects a real local setup. These guard that mapping via the agent
 * registry.
 */

test("the registry covers every built-in agent with display names", () => {
  assert.deepEqual(
    allAgents().map((a) => a.id).sort(),
    ["antigravity", "claude", "codex"],
  );
  assert.equal(getAgent("claude")!.displayName, "Claude Code");
  assert.equal(getAgent("codex")!.displayName, "Codex");
  assert.equal(getAgent("antigravity")!.displayName, "Antigravity");
});

test("detectedAgents reflects CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_HOME presence", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adg-agents-"));
  try {
    const claude = join(tmp, "claude");
    const codex = join(tmp, "codex");
    const gemini = join(tmp, "gemini");
    mkdirSync(claude);
    // codex dir and gemini/antigravity-cli intentionally absent

    const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, GEMINI_HOME: gemini } as NodeJS.ProcessEnv;

    assert.deepEqual(detectedAgents(env).map((a) => a.id), ["claude"]);

    mkdirSync(codex);
    // Antigravity detects its `antigravity-cli` subdir under GEMINI_HOME, not the
    // bare Gemini home — so creating only `gemini/` must not register it yet.
    mkdirSync(gemini);
    assert.deepEqual(detectedAgents(env).map((a) => a.id).sort(), ["claude", "codex"]);

    mkdirSync(join(gemini, "antigravity-cli"));
    assert.deepEqual(detectedAgents(env).map((a) => a.id).sort(), ["antigravity", "claude", "codex"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
