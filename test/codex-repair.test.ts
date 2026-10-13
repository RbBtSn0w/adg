import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmp, scaffoldSource } from "./helpers.ts";
import { installPlugin } from "../src/commands/install.ts";
import { enablePlugins } from "../src/commands/state.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import type { Agent } from "../src/agents/types.ts";
import { repairCodex } from "../src/commands/runtime-repair.ts";
import { pluginStatus } from "../src/commands/status.ts";
import { parseCodexInspection } from "../src/agents/codex.ts";

test("detailed parser scopes identities and rejects malformed or contradictory snapshots", () => {
  const record = { name: "demo", pluginId: "demo@adg", marketplaceName: "adg", installed: true, enabled: false };
  const snapshot = (records: unknown[]) => JSON.stringify({ installed: records, available: [] });
  assert.deepEqual(parseCodexInspection(snapshot([record]), "adg"), [{ id: "demo@adg", name: "demo", installed: true, enabled: false }]);
  assert.deepEqual(parseCodexInspection(snapshot([{ ...record, marketplaceName: "other" }]), "adg"), []);
  for (const invalid of [{ ...record, enabled: "false" }, { ...record, installed: false, enabled: true }, { ...record, pluginId: "demo@other" }]) {
    assert.equal(parseCodexInspection(snapshot([invalid]), "adg"), undefined);
  }
  assert.equal(parseCodexInspection(snapshot([record, record]), "adg"), undefined);
  assert.equal(parseCodexInspection("{}", "adg"), undefined);
});

test("status splits absence from disablement; failed repair queries never install", () => {
  const root = tmp();
  const previous = process.env.ADG_CACHE_HOME;
  process.env.ADG_CACHE_HOME = join(root, "cache");
  try {
    const { dir } = scaffoldSource(root);
    const store = join(root, "store");
    installPlugin({ source: dir, pluginsDir: store });
    const agent = {
      id: "codex", displayName: "Codex", adaptTarget: "codex", detect: () => true, available: () => true,
      inspectPlugins: () => [{ id: "pkgdemo@adg", name: "pkgdemo", installed: true, enabled: false }],
      activate: () => { throw new Error("must not install"); },
      refresh: () => { throw new Error("must not refresh"); },
      deactivate: () => { throw new Error("must not remove"); },
    } as Agent;
    const [status] = pluginStatus({ pluginsDir: store, scope: "user", agents: [agent] });
    assert.deepEqual(status!.missing, ["pkgdemo"]);
    assert.deepEqual(status!.runtimeMissing, []);
    assert.deepEqual(status!.runtimeDisabled, ["pkgdemo"]);
    const ctx = { pluginsDir: store, plugins: ["pkgdemo"], scope: "user" as const };
    assert.deepEqual(repairCodex(ctx, false, agent).affected, []);
    agent.inspectPlugins = () => ({ error: "query failed" });
    assert.equal(repairCodex(ctx, false, agent).failures?.[0]?.stage, "inspect");
    agent.inspectPlugins = undefined;
    assert.equal(repairCodex(ctx, false, agent).failures?.[0]?.stage, "inspect");
  } finally {
    if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair reports failed verification and healthy repetition does not reinstall", () => {
  const root = tmp();
  const previous = process.env.ADG_CACHE_HOME;
  process.env.ADG_CACHE_HOME = join(root, "cache");
  try {
    const { dir } = scaffoldSource(root);
    const store = join(root, "store");
    installPlugin({ source: dir, pluginsDir: store });
    let installed = false;
    let installs = 0;
    const agent = {
      id: "codex", displayName: "Codex", adaptTarget: "codex", detect: () => true, available: () => true,
      inspectPlugins: () => [{ id: "pkgdemo@adg", name: "pkgdemo", installed, enabled: installed }],
      activate: () => { installs++; return { agent: "codex", affected: ["pkgdemo"], skipped: false }; },
      refresh: () => ({ agent: "codex", affected: [], skipped: false }),
      deactivate: () => ({ agent: "codex", affected: [], skipped: false }),
    } as Agent;
    const ctx = { pluginsDir: store, plugins: ["pkgdemo"], scope: "user" as const };
    assert.equal(repairCodex(ctx, false, agent).failures?.[0]?.stage, "verify");
    installed = true;
    assert.deepEqual(repairCodex(ctx, false, agent).affected, []);
    assert.equal(installs, 1);
  } finally {
    if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("enable restores an already-enabled plugin missing from Codex", () => {
  const root = tmp();
  const previous = process.env.ADG_CACHE_HOME;
  process.env.ADG_CACHE_HOME = join(root, "cache");
  try {
    const { dir } = scaffoldSource(root);
    const store = join(root, "store");
    installPlugin({ source: dir, pluginsDir: store });
    let installed = false;
    const agent = {
      id: "codex", displayName: "Codex", adaptTarget: "codex", detect: () => true, available: () => true,
      inspectPlugins: () => [{ id: "pkgdemo@adg", name: "pkgdemo", installed, enabled: installed }],
      activate: () => { installed = true; return { agent: "codex", affected: ["pkgdemo"], skipped: false }; },
      refresh: () => ({ agent: "codex", affected: [], skipped: false }),
      deactivate: () => ({ agent: "codex", affected: [], skipped: false }),
    } as Agent;
    enablePlugins({ pluginsDir: store, names: ["pkgdemo"], scope: "user", agents: [agent] });
    assert.equal(installed, true);
  } finally {
    if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("unchanged update repairs only with explicit repair and preserves runtime disablement", async () => {
  const root = tmp();
  const previous = process.env.ADG_CACHE_HOME;
  process.env.ADG_CACHE_HOME = join(root, "cache");
  try {
    const { dir } = scaffoldSource(root);
    const store = join(root, "store");
    const revision = "a".repeat(40);
    installPlugin({ source: dir, pluginsDir: store, origin: { type: "github", repo: "example/demo", path: "." }, resolvedRevision: revision });
    let installed = false;
    let enabled = false;
    const agent = {
      id: "codex", displayName: "Codex", adaptTarget: "codex", detect: () => true, available: () => true,
      inspectPlugins: () => [{ id: "pkgdemo@adg", name: "pkgdemo", installed, enabled }],
      activate: () => { installed = enabled = true; return { agent: "codex", affected: ["pkgdemo"], skipped: false }; },
      refresh: () => ({ agent: "codex", affected: [], skipped: false }),
      deactivate: () => ({ agent: "codex", affected: [], skipped: false }),
    } as Agent;
    const options = { pluginsDir: store, agents: [agent], activate: true, revisionResolver: () => revision };
    await updatePlugins(options);
    assert.equal(installed, false);
    await updatePlugins({ ...options, repair: true });
    assert.equal(installed, true);
    enabled = false;
    await updatePlugins({ ...options, repair: true });
    assert.equal(enabled, false);
  } finally {
    if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed local sources preserve runtime disablement and never write after failed inspection", async () => {
  const root = tmp();
  const previous = process.env.ADG_CACHE_HOME;
  process.env.ADG_CACHE_HOME = join(root, "cache");
  try {
    const { dir } = scaffoldSource(root);
    const store = join(root, "store");
    installPlugin({ source: dir, pluginsDir: store });
    let enabled = false;
    let writes = 0;
    const write = () => { writes++; enabled = true; return { agent: "codex", affected: ["pkgdemo"], skipped: false }; };
    const agent: Agent = {
      id: "codex", displayName: "Codex", adaptTarget: "codex", detect: () => true, available: () => true,
      inspectPlugins: () => [{ id: "pkgdemo@adg", name: "pkgdemo", installed: true, enabled }],
      activate: write, refresh: write, deactivate: write,
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Changed.\n---\n");
    await updatePlugins({ pluginsDir: store, agents: [agent], activate: true, repair: true });
    assert.equal(enabled, false);
    assert.equal(writes, 0);
    agent.inspectPlugins = () => ({ error: "snapshot unavailable" });
    writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Changed again.\n---\n");
    const result = await updatePlugins({ pluginsDir: store, agents: [agent], activate: true, repair: true });
    assert.equal(writes, 0);
    assert.equal(result.agents[0]?.failures?.[0]?.stage, "inspect");
    enabled = true;
    agent.inspectPlugins = () => [{ id: "pkgdemo@adg", name: "pkgdemo", installed: true, enabled }];
    writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: New enabled content.\n---\n");
    const refreshed = await updatePlugins({ pluginsDir: store, agents: [agent], activate: true, repair: true });
    assert.equal(writes, 1);
    assert.deepEqual(refreshed.agents[0]?.verified, ["pkgdemo"]);
  } finally {
    if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped recovery orders dependencies, blocks dependents on failure, and continues independent plugins", async () => {
  const root = tmp();
  const previous = process.env.ADG_CACHE_HOME;
  process.env.ADG_CACHE_HOME = join(root, "cache");
  try {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const store = join(root, "store");
    for (const [name, dependency] of [["base", undefined], ["consumer", "base"], ["independent", undefined]] as const) {
      const { dir } = scaffoldSource(join(root, name));
      const file = join(dir, ".agents", ".plugin.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.name = name;
      if (dependency) manifest.dependencies = [{ name: dependency, version: "0.1.0" }];
      writeFileSync(file, JSON.stringify(manifest));
      installPlugin({ source: dir, pluginsDir: store });
    }
    const installed = new Set<string>();
    const calls: string[] = [];
    let failBase = true;
    const agent: Agent = {
      id: "codex", displayName: "Codex", adaptTarget: "codex", detect: () => true, available: () => true,
      inspectPlugins: () => ["base", "consumer", "independent"].map((name) => ({ id: `${name}@adg`, name, installed: installed.has(name), enabled: installed.has(name) })),
      activate: (ctx) => {
        calls.push(...ctx.plugins);
        if (failBase && ctx.plugins.includes("base")) return { agent: "codex", affected: [], skipped: false, failures: [{ plugin: "base", stage: "install", errorType: "CLI_FAILURE", message: "rejected" }] };
        ctx.plugins.forEach((name) => installed.add(name));
        return { agent: "codex", affected: ctx.plugins, skipped: false };
      },
      refresh: () => ({ agent: "codex", affected: [], skipped: false }),
      deactivate: () => ({ agent: "codex", affected: [], skipped: false }),
    };
    const ctx = { pluginsDir: store, plugins: ["consumer", "independent", "base"], scope: "user" as const };
    const failed = repairCodex(ctx, false, agent);
    assert.deepEqual(calls, ["base", "independent"]);
    assert.deepEqual(failed.verified, ["independent"]);
    assert.ok(failed.failures?.some((failure) => failure.plugin === "consumer" && failure.errorType === "DEPENDENCY_UNAVAILABLE"));
    calls.length = 0;
    failBase = false;
    const restored = repairCodex(ctx, false, agent);
    assert.deepEqual(calls, ["base", "consumer"]);
    assert.deepEqual(restored.verified, ["base", "consumer"]);
    installed.delete("consumer");
    installed.delete("base");
    calls.length = 0;
    const scoped = repairCodex({ ...ctx, plugins: ["consumer"] }, false, agent);
    assert.deepEqual(calls, []);
    assert.equal(scoped.failures?.[0]?.errorType, "DEPENDENCY_UNAVAILABLE");
  } finally {
    if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed verification renders an unverified installation rather than enabled success", async () => {
  const { renderAgentReport } = await import("../src/render/plugins.ts");
  const lines = renderAgentReport([{ agent: "codex", affected: ["demo"], skipped: false, verified: [], unverified: ["demo"], failures: [{ plugin: "demo", stage: "verify", errorType: "REGISTRATION_MISSING", message: "not verified" }] }], "enabled").join("\n");
  assert.match(lines, /recovery unverified/);
  assert.doesNotMatch(lines, /enabled in/);
});
