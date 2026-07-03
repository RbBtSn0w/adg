import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installPlugin } from "../src/commands/install.ts";
import { disablePlugins, enablePlugins } from "../src/commands/state.ts";
import { readLock } from "../src/lock.ts";
import type { Agent, AgentContext, AgentSyncResult } from "../src/agents/index.ts";
import { ADG_SCHEMA_VERSION, pluginState } from "../src/types.ts";
import { tmp } from "./helpers.ts";

interface Calls {
  activate: string[][];
  deactivate: string[][];
}

function agent(id: "codex" | "claude", calls: Calls, available = true): Agent {
  const result = (ctx: AgentContext): AgentSyncResult => ({
    agent: id,
    affected: available ? ctx.plugins : [],
    skipped: !available,
  });
  return {
    id,
    displayName: id,
    adaptTarget: id,
    detect: () => true,
    available: () => available,
    activate: (ctx) => { calls.activate.push(ctx.plugins); return result(ctx); },
    deactivate: (ctx) => { calls.deactivate.push(ctx.plugins); return result(ctx); },
    refresh: result,
  };
}

function seed(store: string, name: string, dependencies: string[] = []): void {
  const src = join(tmp(), name);
  mkdirSync(join(src, ".agents"), { recursive: true });
  writeFileSync(join(src, ".agents", ".plugin.json"), JSON.stringify({
    schemaVersion: ADG_SCHEMA_VERSION,
    name,
    version: "1.0.0",
    description: `${name}.`,
    skills: "./skills/",
    ...(dependencies.length ? { dependencies: dependencies.map((dependency) => ({ name: dependency, version: "1.0.0" })) } : {}),
  }));
  mkdirSync(join(src, "skills", "hello"), { recursive: true });
  writeFileSync(join(src, "skills", "hello", "SKILL.md"), "# hello\n");
  installPlugin({ source: src, pluginsDir: store, now: "2026-07-03T00:00:00Z" });
}

test("legacy lock entries default to enabled and reinstall preserves disabled", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  let lock = readLock(join(store, ".plugin-lock.json"));
  assert.equal(pluginState(lock.plugins.alpha!), "enabled");

  lock.plugins.alpha!.state = "disabled";
  writeFileSync(join(store, ".plugin-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  installPlugin({ source: join(store, "alpha"), pluginsDir: store, now: "2026-07-04T00:00:00Z" });
  lock = readLock(join(store, ".plugin-lock.json"));
  assert.equal(lock.plugins.alpha!.state, "disabled");
  rmSync(work, { recursive: true });
});

test("disable persists desired state, keeps payload and catalog, and deactivates every agent", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  const catalogBefore = readFileSync(join(store, "marketplace.json"), "utf8");
  const calls: Calls = { activate: [], deactivate: [] };

  const result = disablePlugins({
    pluginsDir: store,
    names: ["alpha"],
    scope: "project",
    agents: [agent("codex", calls), agent("claude", calls, false)],
  });

  assert.equal(readLock(join(store, ".plugin-lock.json")).plugins.alpha!.state, "disabled");
  assert.ok(existsSync(join(store, "alpha")));
  assert.equal(readFileSync(join(store, "marketplace.json"), "utf8"), catalogBefore);
  assert.deepEqual(calls.deactivate, [["alpha"], ["alpha"]]);
  assert.equal(result.changed[0], "alpha");
  assert.equal(result.agents[1]!.skipped, true);
  rmSync(work, { recursive: true });
});

test("disable refuses an enabled dependency required by another enabled plugin", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "base");
  seed(store, "consumer", ["base"]);

  assert.throws(
    () => disablePlugins({ pluginsDir: store, names: ["base"], scope: "project", agents: [] }),
    /required by enabled plugin\(s\): consumer/,
  );
  assert.equal(pluginState(readLock(join(store, ".plugin-lock.json")).plugins.base!), "enabled");
  rmSync(work, { recursive: true });
});

test("enable restores disabled dependencies in dependency-first order and activates all agents", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "base");
  seed(store, "consumer", ["base"]);
  const lock = readLock(join(store, ".plugin-lock.json"));
  lock.plugins.base!.state = "disabled";
  lock.plugins.consumer!.state = "disabled";
  writeFileSync(join(store, ".plugin-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  const calls: Calls = { activate: [], deactivate: [] };

  const result = enablePlugins({
    pluginsDir: store,
    names: ["consumer"],
    scope: "project",
    agents: [agent("codex", calls)],
  });

  assert.deepEqual(result.order, ["base", "consumer"]);
  assert.deepEqual(result.changed, ["base", "consumer"]);
  assert.deepEqual(calls.activate, [["base", "consumer"]]);
  const updated = readLock(join(store, ".plugin-lock.json"));
  assert.equal(pluginState(updated.plugins.base!), "enabled");
  assert.equal(pluginState(updated.plugins.consumer!), "enabled");
  rmSync(work, { recursive: true });
});
