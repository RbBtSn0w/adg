import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allAgents, detectedAgents, getAgent } from "../src/agents/index.ts";

/**
 * The `adg plugins add` interactive flow pre-selects the agents present on the
 * machine. Detection keys off CODEX_HOME / CLAUDE_CONFIG_DIR so the prompt
 * reflects a real local setup. These guard that mapping via the agent registry.
 */

test("the registry covers both built-in agents with display names", () => {
  assert.deepEqual(
    allAgents().map((a) => a.id).sort(),
    ["claude", "codex"],
  );
  assert.equal(getAgent("claude")!.displayName, "Claude Code");
  assert.equal(getAgent("codex")!.displayName, "Codex");
});

test("detectedAgents reflects CODEX_HOME / CLAUDE_CONFIG_DIR presence", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adg-agents-"));
  try {
    const claude = join(tmp, "claude");
    const codex = join(tmp, "codex");
    mkdirSync(claude);
    // codex dir intentionally absent

    const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } as NodeJS.ProcessEnv;

    assert.deepEqual(detectedAgents(env).map((a) => a.id), ["claude"]);

    mkdirSync(codex);
    assert.deepEqual(detectedAgents(env).map((a) => a.id).sort(), ["claude", "codex"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
