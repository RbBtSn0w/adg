import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileHooks, parseAdgHooks, type AdgHooks } from "../src/hooks.ts";

const fixture = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/superpowers/${rel}`, import.meta.url)), "utf8"));

/**
 * The golden case: a single universal hooks document must reproduce superpowers'
 * two hand-authored native files exactly — proving the DSL can express a plugin
 * that genuinely diverges per agent (different matcher + different script) via
 * per-target overrides, and that the env token is translated per target.
 */
const SUPERPOWERS: AdgHooks = {
  schemaVersion: "adg.hooks/v1",
  hooks: {
    SessionStart: [
      {
        matcher: "startup|clear|compact",
        matcherByTarget: { codex: "startup|resume|clear" },
        actions: [
          {
            type: "command",
            command: '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
            commandByTarget: { codex: '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start-codex' },
            async: false,
          },
        ],
      },
    ],
  },
};

test("compileHooks reproduces superpowers' Claude hooks.json", () => {
  const { hooks, warnings } = compileHooks(SUPERPOWERS, "claude");
  assert.deepEqual(hooks, fixture("hooks/hooks.json"));
  assert.deepEqual(warnings, []);
});

test("compileHooks reproduces superpowers' Codex hooks-codex.json", () => {
  const { hooks, warnings } = compileHooks(SUPERPOWERS, "codex");
  assert.deepEqual(hooks, fixture("hooks/hooks-codex.json"));
  assert.deepEqual(warnings, []);
});

test("compileHooks translates the env token per target", () => {
  const src: AdgHooks = {
    schemaVersion: "adg.hooks/v1",
    hooks: { SessionStart: [{ actions: [{ type: "command", command: "${PLUGIN_ROOT}/x" }] }] },
  };
  assert.equal(compileHooks(src, "claude").hooks.hooks.SessionStart![0]!.hooks[0]!.command, "${CLAUDE_PLUGIN_ROOT}/x");
  assert.equal(compileHooks(src, "codex").hooks.hooks.SessionStart![0]!.hooks[0]!.command, "${PLUGIN_ROOT}/x");
});

test("compileHooks omits matcher and async when unset", () => {
  const src: AdgHooks = {
    schemaVersion: "adg.hooks/v1",
    hooks: { SessionStart: [{ actions: [{ type: "command", command: "${PLUGIN_ROOT}/x" }] }] },
  };
  const entry = compileHooks(src, "claude").hooks.hooks.SessionStart![0]!;
  assert.ok(!("matcher" in entry), "no matcher emitted when unset");
  assert.ok(!("async" in entry.hooks[0]!), "no async emitted when unset");
});

test("compileHooks warns (does not drop) on an unknown event", () => {
  const src: AdgHooks = {
    schemaVersion: "adg.hooks/v1",
    hooks: { TotallyMadeUp: [{ actions: [{ type: "command", command: "${PLUGIN_ROOT}/x" }] }] },
  };
  const { hooks, warnings } = compileHooks(src, "codex");
  assert.ok(hooks.hooks.TotallyMadeUp, "unknown event is still emitted");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /unknown hook event "TotallyMadeUp"/);
});

test("parseAdgHooks rejects a wrong schema version and malformed actions", () => {
  assert.throws(() => parseAdgHooks({ schemaVersion: "nope", hooks: {} }), /schemaVersion/);
  assert.throws(
    () => parseAdgHooks({ schemaVersion: "adg.hooks/v1", hooks: { SessionStart: [{ actions: [{ type: "x" }] }] } }),
    /type "command"/,
  );
  // A well-formed document parses through unchanged.
  assert.equal(parseAdgHooks(SUPERPOWERS), SUPERPOWERS);
});
