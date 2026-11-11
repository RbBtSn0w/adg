import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPlugins } from "../src/commands/install.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import { readLock, writeLock } from "../src/lock.ts";
import { lockPath } from "../src/paths.ts";
import type { Agent } from "../src/agents/types.ts";

for (const structural of [false, true]) {
  test(`ordinary ${structural ? "structural" : "explicit"} remote refresh recovers offline before matching-revision checks`, async () => {
    const root = mkdtempSync(join(tmpdir(), "adg-native-update-"));
    const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
    process.env.ADG_NATIVE_RETRY_HOME = join(root, "private");
    const upstream = join(root, "upstream");
    const store = join(root, "store");
    const name = structural ? "custom" : "demo";
    mkdirSync(join(upstream, "skills", "one"), { recursive: true });
    const skill = join(upstream, "skills", "one", "SKILL.md");
    writeFileSync(skill, "---\nname: one\ndescription: Synthetic\n---\nOriginal\n");
    if (!structural) {
      mkdirSync(join(upstream, ".agents"));
      writeFileSync(join(upstream, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name, version: "1.0.0", description: "Synthetic", skills: "./skills" }));
    }
    let fail = true;
    let calls = 0;
    let probes = 0;
    const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true,
      retrySafeOperations: ["refresh"], listInstalled: () => [name],
      activate: () => { throw new Error("must refresh"); }, deactivate: () => { throw new Error("unexpected"); },
      refresh: ctx => { calls++; return { agent: "fake", affected: fail ? [] : ctx.plugins, skipped: false,
        ...(fail ? { failures: [{ plugin: name, stage: "install" as const, errorType: "TEST", message: "retry native" }] } : { verified: ctx.plugins }) }; } };
    const clone = (args: string[]) => cpSync(upstream, args[args.length - 1]!, { recursive: true });
    try {
      await addPlugins({ spec: "example/public", pluginsDir: store, gitRunner: clone, ...(structural ? { as: name } : {}) });
      const lock = readLock(lockPath(store));
      lock.plugins[name]!.resolvedRevision = "old";
      writeLock(lockPath(store), lock);
      writeFileSync(skill, "---\nname: one\ndescription: Synthetic\n---\nUpdated\n");
      const first = await updatePlugins({ pluginsDir: store, gitRunner: clone, activate: true, agents: [agent], revisionResolver: () => { probes++; return "new"; } });
      assert.equal(first.agents[0]?.failures?.length, 1);
      assert.equal(calls, 1);
      fail = false;
      rmSync(upstream, { recursive: true });
      const replay = await updatePlugins({ pluginsDir: store, activate: true, agents: [agent],
        revisionResolver: () => { throw new Error("offline: must not probe"); }, gitRunner: () => { throw new Error("offline: must not clone"); } });
      assert.equal(replay.remote[0]?.failed, undefined);
      assert.equal(replay.remote[0]?.pendingRuntime, undefined);
      assert.equal(replay.remote[0]?.resumed, true);
      assert.equal(calls, 2);
      assert.equal(probes, 1);
      assert.deepEqual(replay.agents[0]?.verified, [name]);
      await updatePlugins({ pluginsDir: store, activate: true, agents: [agent], revisionResolver: () => "new" });
      assert.equal(calls, 2, "completed retries do not execute again");
    } finally {
      if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("an unchanged remote revision repairs only native targets with stale projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-native-projection-"));
  try {
    const source = join(root, "upstream");
    mkdirSync(join(source, ".agents"), { recursive: true });
    writeFileSync(join(source, ".agents", ".plugin.json"), JSON.stringify({
      schemaVersion: "adg.plugin/v1", name: "example", version: "1.0.0", description: "Synthetic",
    }));
    const store = join(root, "store");
    await addPlugins({ spec: "example/public", pluginsDir: store, gitRunner: args => cpSync(source, args.at(-1)!, { recursive: true }) });
    const lock = readLock(lockPath(store));
    lock.plugins.example!.resolvedRevision = "current";
    writeLock(lockPath(store), lock);
    let repairs = 0;
    const agent: Agent = {
      id: "test", displayName: "Test", adaptTarget: "antigravity", detect: () => true, available: () => true,
      needsProjectionRefresh: ctx => repairs ? [] : ctx.plugins,
      refresh: ctx => { repairs++; return { agent: "test", affected: ctx.plugins, skipped: false }; },
      activate: () => { throw new Error("unexpected install"); },
      deactivate: () => { throw new Error("unexpected removal"); },
    };
    const opts = { pluginsDir: store, activate: true, agents: [agent], revisionResolver: () => "current",
      gitRunner: () => { throw new Error("verified checkout must be reused"); } };
    const first = await updatePlugins(opts);
    assert.equal(first.remote[0]?.failed, undefined);
    assert.deepEqual(first.agents[0]?.affected, ["example"]);
    const second = await updatePlugins(opts);
    assert.deepEqual(second.agents, []);
    assert.equal(repairs, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
