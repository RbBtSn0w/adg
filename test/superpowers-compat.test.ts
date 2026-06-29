import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { addPlugins } from "../src/commands/install.ts";

/**
 * Cross-agent compatibility contract, pinned against a vendored `superpowers`
 * fixture (skills + per-agent hook variants). superpowers is the real-world
 * reference for a plugin that ships hooks for both Claude and Codex, so it guards
 * the whole reverse → install/package → adapt round-trip from regressing.
 *
 * Offline: drives the pure pipeline (`addPlugins` with `activate` off), never the
 * real `claude`/`codex` CLIs.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/superpowers", import.meta.url));

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Run the full add pipeline (reverse-adapt → install/package → adapt to
 * claude+codex) on an isolated copy of the fixture, returning the installed dir.
 */
async function installFixture(): Promise<{ dir: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "adg-sp-"));
  const src = join(root, "src");
  // Copy so the pipeline's reverse-adapt (.agents/.plugin.json) and re-adapt
  // never mutate the committed fixture.
  cpSync(FIXTURE, src, { recursive: true });
  const store = join(root, "store");

  const res = await addPlugins({
    spec: src,
    pluginsDir: store,
    all: true,
    targets: ["claude", "codex"],
    now: "2026-06-25T00:00:00.000Z",
  });
  assert.equal(res.installed.length, 1, "fixture installs exactly one plugin");
  return { dir: res.installed[0]!.installedTo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("reverse-adapt recovers the hooks directory the Claude manifest omits", async () => {
  const { dir, cleanup } = await installFixture();
  try {
    // walkNative prefers the Claude manifest, which omits `hooks` (auto-load);
    // the reverse step must recover it from the on-disk hooks/ dir.
    const adg = readJson(join(dir, ".agents", ".plugin.json"));
    assert.equal(adg.hooks, "./hooks/", "ADG manifest must declare the hooks directory");
    assert.equal(adg.skills, "./skills/", "skills must survive reverse-adapt");
  } finally {
    cleanup();
  }
});

test("packaging copies both hook variants, scripts, and skills", async () => {
  const { dir, cleanup } = await installFixture();
  try {
    for (const rel of [
      "hooks/hooks.json",
      "hooks/hooks-codex.json",
      "hooks/run-hook.cmd",
      "hooks/session-start",
      "hooks/session-start-codex",
      "skills/using-superpowers/SKILL.md",
      "skills/test-driven-development/SKILL.md",
      "skills/systematic-debugging/SKILL.md",
    ]) {
      assert.ok(existsSync(join(dir, rel)), `payload must include ${rel}`);
    }
  } finally {
    cleanup();
  }
});

test("Claude projection omits hooks (auto-loaded) and keeps skills", async () => {
  const { dir, cleanup } = await installFixture();
  try {
    const claude = readJson(join(dir, ".claude-plugin", "plugin.json"));
    assert.equal(
      claude.hooks,
      undefined,
      "Claude auto-loads hooks/hooks.json; declaring it would duplicate the load",
    );
    assert.equal(claude.skills, "./skills/", "Claude projection keeps the skills root");
  } finally {
    cleanup();
  }
});

test("Codex projection references the codex hook file and keeps skills", async () => {
  const { dir, cleanup } = await installFixture();
  try {
    const codex = readJson(join(dir, ".codex-plugin", "plugin.json"));
    // Codex has no auto-load, so it must reference an explicit file — and the
    // codex-specific variant, not Claude's.
    assert.equal(codex.hooks, "./hooks/hooks-codex.json", "Codex must reference its own hook file");
    assert.equal(codex.skills, "./skills/", "Codex projection keeps the skills root");
  } finally {
    cleanup();
  }
});

test("aggregate: every shipped feature survives the round-trip", async () => {
  const { dir, cleanup } = await installFixture();
  try {
    // Claude consumes hooks/hooks.json (auto-load) + skills; Codex consumes
    // hooks/hooks-codex.json (declared) + skills. Both variants must be present
    // on disk so each agent's projection resolves to a real file.
    const claudeHook = readJson(join(dir, "hooks", "hooks.json"));
    const codexHook = readJson(join(dir, "hooks", "hooks-codex.json"));
    assert.ok((claudeHook as { hooks?: unknown }).hooks, "claude hook config present");
    assert.ok((codexHook as { hooks?: unknown }).hooks, "codex hook config present");
    // And the two are genuinely distinct (different env token / matcher), proving
    // we preserved both rather than collapsing to one.
    assert.notDeepEqual(claudeHook, codexHook, "the two hook variants must stay distinct");
  } finally {
    cleanup();
  }
});
