// Shared fixture for integration tests that spawn the real `bin/adg.ts` CLI as
// a subprocess. Not a *.test.mjs file, so the test runner imports it without
// treating it as a test module.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spawn the real `bin/adg.ts` CLI with every agent's config home forced into a
 * throwaway temp directory, so an integration test that exercises `activate`
 * (which shells out to whatever agent CLIs happen to be installed on the
 * machine running the test) can never register a marketplace or write a
 * plugin cache into this machine's REAL `~/.claude`, `~/.codex`, or
 * `~/.gemini` — regardless of which agents are actually present there.
 *
 * This closes the hole that let `test/cache-sandbox.test.mjs` leak dozens of
 * `adg-<hash>` marketplace registrations into a developer's real Claude Code
 * and Codex config between 2026-07-12 and 2026-07-13: that test spawned
 * `bin/adg.ts plugins add` (default `activate: true`, no `--target`) without
 * isolating `CLAUDE_CONFIG_DIR`, so `syncMarketplace()` drove the real,
 * globally-installed `claude` CLI against a temp directory the test deleted
 * moments later. See `adg plugins prune` for cleaning up registrations that
 * already leaked this way.
 *
 * A caller that legitimately needs one agent's *real* config (e.g. proving a
 * generated manifest crosses into that agent's actual cache) passes that one
 * override explicitly via `env` — every other agent stays isolated.
 */
export function spawnAdg(args, { env = {}, isolationRoot } = {}) {
  const root = isolationRoot ?? mkdtempSync(join(tmpdir(), "adg-test-isolation-"));
  const defaultHomes = {
    CLAUDE_CONFIG_DIR: join(root, "claude-home"),
    CODEX_HOME: join(root, "codex-home"),
    GEMINI_HOME: join(root, "gemini-home"),
  };
  // Pre-create every default home so an agent CLI that doesn't lazily
  // vivify its own config dir (unlike `claude`, which does) still gets a
  // real, isolated directory instead of silently no-oping against a path
  // that never came into existence.
  for (const [key, dir] of Object.entries(defaultHomes)) {
    if (!(key in env)) mkdirSync(dir, { recursive: true });
  }
  const isolatedEnv = { ...process.env, ...defaultHomes, ...env };
  const result = spawnSync(process.execPath, ["bin/adg.ts", ...args], { env: isolatedEnv, encoding: "utf8" });
  return { result, root };
}
