import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { liftHooks, liftHooksFromDisk, compileHooks, type AdgHooks, type NativeHooks } from "../src/hooks.ts";
import { runPlugins } from "../src/cli/handlers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/superpowers", import.meta.url));
const fixture = (rel: string): NativeHooks => JSON.parse(readFileSync(join(FIXTURE, rel), "utf8"));
const tmp = (): string => mkdtempSync(join(tmpdir(), "adg-lift-"));

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

// ---- liftHooksFromDisk (reads/writes a plugin dir) ----

test("liftHooksFromDisk writes a .agents/hooks.json that compiles back to both natives", () => {
  const dir = tmp();
  try {
    cpSync(FIXTURE, dir, { recursive: true });
    const res = liftHooksFromDisk(dir)!;
    assert.equal(res.file, ".agents/hooks.json");
    assert.deepEqual(res.sources, ["claude", "codex"]);
    assert.deepEqual(res.warnings, []);

    const dsl = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8")) as AdgHooks;
    assert.equal(dsl.schemaVersion, "adg.hooks/v1");
    assert.deepEqual(compileHooks(dsl, "claude").hooks, fixture("hooks/hooks.json"));
    assert.deepEqual(compileHooks(dsl, "codex").hooks, fixture("hooks/hooks-codex.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liftHooksFromDisk is a no-op (undefined) when the plugin ships no native hooks", () => {
  const dir = tmp();
  try {
    assert.equal(liftHooksFromDisk(dir), undefined);
    assert.ok(!existsSync(join(dir, ".agents", "hooks.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("liftHooksFromDisk throws on a malformed native hooks file", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks", "hooks.json"), '{"not":"hooks"}');
    assert.throws(() => liftHooksFromDisk(dir), /not a valid hooks file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`plugins lift-hooks <dir>` writes the unified DSL", async () => {
  const dir = tmp();
  const origLog = console.log;
  console.log = () => {};
  try {
    cpSync(FIXTURE, dir, { recursive: true });
    await runPlugins("lift-hooks", [dir]);
    assert.ok(existsSync(join(dir, ".agents", "hooks.json")), "lift-hooks must write the DSL file");
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
