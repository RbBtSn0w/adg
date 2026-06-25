import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { liftHooks, compileHooks, type NativeHooks } from "../src/hooks.ts";

const fixture = (rel: string): NativeHooks =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/superpowers/${rel}`, import.meta.url)), "utf8"));

/**
 * Reverse (lift) must be the faithful inverse of compile: lifting superpowers'
 * two hand-authored native files into one universal document, then recompiling,
 * reproduces both originals byte-for-byte — including the genuinely divergent
 * matcher and script, captured as per-target overrides.
 */
test("liftHooks unifies the two native variants, round-tripping via compileHooks", () => {
  const claudeNative = fixture("hooks/hooks.json");
  const codexNative = fixture("hooks/hooks-codex.json");

  const { hooks: dsl, warnings } = liftHooks({ claude: claudeNative, codex: codexNative });
  assert.deepEqual(warnings, []);

  assert.deepEqual(compileHooks(dsl, "claude").hooks, claudeNative);
  assert.deepEqual(compileHooks(dsl, "codex").hooks, codexNative);
});

test("liftHooks from a single target canonicalizes the env token (no overrides)", () => {
  const { hooks: dsl } = liftHooks({ claude: fixture("hooks/hooks.json") });
  const action = dsl.hooks.SessionStart![0]!.actions[0]!;
  assert.match(action.command, /\$\{PLUGIN_ROOT\}/, "Claude's env token is canonicalized");
  assert.equal(action.commandByTarget, undefined, "no override when only one target is lifted");
});

test("liftHooks reports a shape mismatch instead of dropping it", () => {
  const claudeNative: NativeHooks = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "${PLUGIN_ROOT}/a" }] }] } };
  const codexNative: NativeHooks = { hooks: { SessionStart: [] } };
  const { warnings } = liftHooks({ claude: claudeNative, codex: codexNative });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /different shape per target/);
});
