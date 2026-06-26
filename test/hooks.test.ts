import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkHookEvents } from "../src/hooks.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "adg-hooklint-"));

function writeHooks(dir: string, file: string, events: string[]): void {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  const hooks = Object.fromEntries(
    events.map((e) => [e, [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/x" }] }]]),
  );
  writeFileSync(join(dir, "hooks", file), JSON.stringify({ hooks }));
}

test("checkHookEvents warns per target: a Claude-only event is a no-op in Codex", () => {
  const dir = tmp();
  try {
    // The real speckit case: UserPromptExpansion exists in Claude, not Codex.
    writeHooks(dir, "hooks.json", ["UserPromptExpansion"]);
    const w = checkHookEvents(dir, ["claude", "codex"]);
    assert.equal(w.length, 1, "exactly one warning (codex only)");
    assert.match(w[0]!, /"UserPromptExpansion" is not a known codex hook event/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkHookEvents is silent when every event is supported by the target", () => {
  const dir = tmp();
  try {
    writeHooks(dir, "hooks.json", ["SessionStart", "PreToolUse"]); // both in claude + codex
    assert.deepEqual(checkHookEvents(dir, ["claude", "codex"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkHookEvents lints the codex-specific file when the plugin ships one", () => {
  const dir = tmp();
  try {
    writeHooks(dir, "hooks.json", ["SessionStart"]); // claude file: fine
    writeHooks(dir, "hooks-codex.json", ["SessionEnd"]); // codex reads this; SessionEnd is Claude-only
    const w = checkHookEvents(dir, ["claude", "codex"]);
    assert.equal(w.length, 1);
    assert.match(w[0]!, /"SessionEnd" is not a known codex hook event/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkHookEvents is a no-op when the plugin ships no hooks", () => {
  const dir = tmp();
  try {
    assert.deepEqual(checkHookEvents(dir, ["claude", "codex"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
