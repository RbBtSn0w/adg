import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { addPlugins } from "../src/commands/install.ts";
import { adaptPlugin } from "../src/commands/adapt.ts";

/**
 * Forward DSL path: a plugin authored once with `.agents/hooks.json` compiles to
 * each agent's native hook file during install, the per-agent manifests reference
 * them correctly, and re-adapting is hash-stable (compiled files are generated,
 * not content).
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/dsl-hooks", import.meta.url));
const readJson = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, "utf8"));

async function installFixture(): Promise<{ dir: string; changed: boolean; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "adg-dsl-"));
  const src = join(root, "src");
  cpSync(FIXTURE, src, { recursive: true });
  const store = join(root, "store");
  const res = await addPlugins({
    spec: src,
    pluginsDir: store,
    all: true,
    targets: ["claude", "codex"],
    now: "2026-06-25T00:00:00.000Z",
  });
  const r = res.installed[0]!;
  return { dir: r.installedTo, changed: r.changed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("DSL compiles to both native hook files with per-target env token + overrides", async () => {
  const { dir, cleanup } = await installFixture();
  try {
    const claude = readJson(join(dir, "hooks", "hooks.json"));
    const codex = readJson(join(dir, "hooks", "hooks-codex.json"));
    assert.deepEqual(claude, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|clear|compact",
            hooks: [
              { type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start', async: false },
            ],
          },
        ],
      },
    });
    assert.deepEqual(codex, {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear",
            hooks: [
              { type: "command", command: '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start-codex', async: false },
            ],
          },
        ],
      },
    });
  } finally {
    cleanup();
  }
});

test("manifests reference the compiled hooks correctly (Claude auto-loads, Codex points to its file)", async () => {
  const { dir, cleanup } = await installFixture();
  try {
    const claudeManifest = readJson(join(dir, ".claude-plugin", "plugin.json"));
    const codexManifest = readJson(join(dir, ".codex-plugin", "plugin.json"));
    assert.equal(claudeManifest.hooks, undefined, "Claude auto-loads the compiled hooks/hooks.json");
    assert.equal(codexManifest.hooks, "./hooks/hooks-codex.json");
  } finally {
    cleanup();
  }
});

test("re-adapting is hash-stable: compiled hook files do not count as content", async () => {
  const { dir, changed, cleanup } = await installFixture();
  try {
    assert.equal(changed, true, "first install is a new plugin");
    // The compiled files now exist in the installed dir; re-adapting must not
    // change them in a way that would shift the content hash on a later install.
    assert.ok(existsSync(join(dir, "hooks", "hooks.json")));
    adaptPlugin(dir, ["claude", "codex"]);
    // Idempotent: a second compile produces byte-identical output.
    const before = readFileSync(join(dir, "hooks", "hooks-codex.json"), "utf8");
    adaptPlugin(dir, ["claude", "codex"]);
    assert.equal(readFileSync(join(dir, "hooks", "hooks-codex.json"), "utf8"), before);
  } finally {
    cleanup();
  }
});
