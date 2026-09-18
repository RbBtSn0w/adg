#!/usr/bin/env node
/**
 * Guard against a class of bug that leaked ~30 stale `adg-<hash>` marketplace
 * registrations into a developer's real Claude Code and Codex config between
 * 2026-07-12 and 2026-07-13: an integration test spawned the real
 * `bin/adg.ts` CLI (whose default `activate: true` shells out to whatever
 * agent CLIs are actually installed on the machine running the test) without
 * isolating those agents' config homes, so it registered a marketplace
 * against a temp directory the test deleted moments later.
 *
 * `test/sandbox-helpers.mjs`'s `spawnAdg()` is the one sanctioned way to spawn
 * `bin/adg.ts` from a test — it forces every agent's config home into a
 * throwaway temp dir by default. This script fails CI if any test file spawns
 * `bin/adg.ts` directly instead (a raw `spawnSync`/`execFileSync`/`execFile`
 * naming `bin/adg.ts` or `bin/adg.js`), so a future test can't reintroduce the
 * same leak. Zero dependencies so it can run in any CI step.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const helperFile = path.join(testDir, "sandbox-helpers.mjs");

// The real node:child_process subprocess entry points (no `spawnAsync` — it
// doesn't exist anywhere in this codebase; `execSync`/`exec` shell out just as
// directly as `spawnSync`/`execFile(Sync)` and were previously missed here).
const SPAWN_CALL_RE = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/;
// Only a quoted string literal counts — this must not fire on a prose mention
// of "bin/adg.ts" in a comment (like this file's own doc comment above). The
// mention can be anywhere inside the literal (e.g. `"node bin/adg.ts plugins
// add x"` for an execSync one-liner), not just the whole literal's content.
const ADG_BIN_LITERAL_RE = /["'`][^"'`]*bin(?:\\\\|\/)adg\.(?:ts|js)[^"'`]*["'`]/;
const ADG_BIN_MENTION_RE = /bin(?:\\\\|\/)adg\.(?:ts|js)/;

const problems = [];
for (const entry of readdirSync(testDir, { recursive: true })) {
  if (!/\.(?:mjs|ts|js)$/.test(entry)) continue;
  const file = path.join(testDir, entry);
  if (file === helperFile) continue; // the one sanctioned raw spawn site

  const text = readFileSync(file, "utf8");
  if (!ADG_BIN_LITERAL_RE.test(text)) continue;
  // A file can spread a spawn call's binary/args across several lines (this
  // repo already does that elsewhere, e.g. test/antigravity-hook-runner.test.ts),
  // so the spawn-call check runs against the WHOLE file rather than requiring
  // it on the same line as the literal — a same-line requirement is exactly
  // what let a multi-line call slip past this guard undetected.
  if (!SPAWN_CALL_RE.test(text)) continue;

  // Line-level scan purely to point the message at roughly where it's spawned.
  const lines = text.split("\n");
  const line = lines.findIndex((l) => ADG_BIN_MENTION_RE.test(l)) + 1;
  problems.push(`${path.relative(root, file)}:${line}: raw subprocess spawn of bin/adg.ts — use spawnAdg() from test/sandbox-helpers.mjs instead`);
}

if (problems.length) {
  console.error("Unisolated test CLI spawn(s) detected:\n  - " + problems.join("\n  - "));
  console.error(
    "\nSpawning bin/adg.ts directly inherits this machine's real agent config homes " +
      "(~/.claude, ~/.codex, ~/.gemini) unless every one of them is isolated by hand. " +
      "spawnAdg() does that by default — see test/sandbox-helpers.mjs.",
  );
  process.exit(1);
}

console.log("check-test-cli-isolation: every bin/adg.ts spawn in test/ goes through spawnAdg(). OK");
