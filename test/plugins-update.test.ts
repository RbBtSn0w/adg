import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initPlugin } from "../src/commands/init.ts";
import { addPlugins } from "../src/commands/install.ts";
import type { GitRunner } from "../src/sources.ts";
import type { Agent } from "../src/agents/index.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import { readLock } from "../src/lock.ts";
import { lockPath } from "../src/paths.ts";

/** A fake codex agent that records every activate() call it receives. */
function recordingAgent(id: string, calls: { id: string; plugins: string[] }[]): Agent {
  return {
    id,
    displayName: id,
    adaptTarget: "codex",
    detect: () => true,
    available: () => true,
    activate: (ctx) => {
      calls.push({ id, plugins: ctx.plugins });
      return { agent: id, affected: ctx.plugins, skipped: false };
    },
    deactivate: () => ({ agent: id, affected: [], skipped: false }),
    refresh: (ctx) => {
      calls.push({ id, plugins: ctx.plugins });
      return { agent: id, affected: ctx.plugins, skipped: false };
    },
  };
}

/** A fake agent that records which lifecycle method (activate vs refresh) was called. */
function recordingAgentByMethod(
  id: string,
  calls: { id: string; method: "activate" | "refresh"; plugins: string[] }[],
): Agent {
  return {
    id,
    displayName: id,
    adaptTarget: "codex",
    detect: () => true,
    available: () => true,
    activate: (ctx) => {
      calls.push({ id, method: "activate", plugins: ctx.plugins });
      return { agent: id, affected: ctx.plugins, skipped: false };
    },
    deactivate: () => ({ agent: id, affected: [], skipped: false }),
    refresh: (ctx) => {
      calls.push({ id, method: "refresh", plugins: ctx.plugins });
      return { agent: id, affected: ctx.plugins, skipped: false };
    },
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "adg-update-"));
}

/** Write a marketplace of native Claude plugins under `dir`, at a given version. */
function writeNativeMarket(dir: string, names: string[], version = "1.0.0"): void {
  for (const name of names) {
    const d = join(dir, name, ".claude-plugin");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "plugin.json"), JSON.stringify({ name, version, description: name }));
  }
}

/** Remove one plugin from a fake remote (simulates an upstream deletion). */
function deleteFromMarket(dir: string, name: string): void {
  rmSync(join(dir, name), { recursive: true, force: true });
}

/** A gitRunner that serves `remote` as the fake clone for any spec. */
function fakeClone(remote: string): GitRunner {
  return (args) => cpSync(remote, args[args.length - 1]!, { recursive: true });
}

const lockNames = (pluginsDir: string) => Object.keys(readLock(lockPath(pluginsDir)).plugins).sort();

test("updatePlugins reports unchanged when the source is identical", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    const { remote: results } = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.unchanged.sort(), ["finance", "sales"]);
    assert.deepEqual(results[0]!.updated, []);
    assert.deepEqual(results[0]!.deleted, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins leaves unchanged plugins untouched (no re-install / no updatedAt bump)", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner, now: "2026-01-01T00:00:00Z" });

    const before = readLock(lockPath(pluginsDir)).plugins;
    const beforeStamps = { sales: before.sales!.updatedAt, finance: before.finance!.updatedAt };
    const beforeHashes = { sales: before.sales!.folderHash, finance: before.finance!.folderHash };

    // Source is byte-identical; a later `now` would be written only if we re-installed.
    await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner, now: "2026-09-09T00:00:00Z" });

    const after = readLock(lockPath(pluginsDir)).plugins;
    assert.equal(after.sales!.updatedAt, beforeStamps.sales, "unchanged plugin keeps its updatedAt");
    assert.equal(after.finance!.updatedAt, beforeStamps.finance, "unchanged plugin keeps its updatedAt");
    assert.equal(after.sales!.folderHash, beforeHashes.sales);
    assert.equal(after.finance!.folderHash, beforeHashes.finance);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins does not re-activate agents for unchanged plugins, but does for changed", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    // Unchanged source → no agent activation at all.
    const idle: { id: string; plugins: string[] }[] = [];
    const r1 = await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgent("codex", idle)],
    });
    assert.deepEqual(idle, [], "no activate call when nothing changed");
    assert.equal(r1.remote[0]!.failed, undefined);

    // Bump only `sales` → exactly that plugin is re-activated.
    writeNativeMarket(remote, ["sales"], "2.0.0");
    const busy: { id: string; plugins: string[] }[] = [];
    await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgent("codex", busy)],
    });
    assert.deepEqual(busy, [{ id: "codex", plugins: ["sales"] }], "only the changed plugin is re-activated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins refreshes (not plain-activates) changed plugins, so cached agents re-pull", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);

    // A fresh add must use activate (first install).
    const addCalls: { id: string; method: "activate" | "refresh"; plugins: string[] }[] = [];
    await addPlugins({
      spec: "acme/market",
      pluginsDir,
      all: true,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgentByMethod("codex", addCalls)],
    });
    assert.deepEqual(
      addCalls.map((c) => c.method),
      ["activate"],
      "fresh add uses activate",
    );

    // Bump `sales` upstream → the update path must refresh it, not plain-activate,
    // so agents that cache a copy (Claude) drop the stale one and re-pull.
    writeNativeMarket(remote, ["sales"], "2.0.0");
    const updateCalls: { id: string; method: "activate" | "refresh"; plugins: string[] }[] = [];
    await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgentByMethod("codex", updateCalls)],
    });
    assert.deepEqual(
      updateCalls,
      [{ id: "codex", method: "refresh", plugins: ["sales"] }],
      "update path refreshes only the changed plugin",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins surfaces remote agent re-sync results in a consolidated report", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    // Bump `sales` so it is re-fetched and re-activated.
    writeNativeMarket(remote, ["sales"], "2.0.0");
    const calls: { id: string; plugins: string[] }[] = [];
    const result = await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgent("codex", calls)],
    });

    // The remote re-activation must appear in the consolidated agent report,
    // not be silently dropped (it previously only surfaced for local rescans).
    assert.deepEqual(
      result.agents.map((a) => [a.agent, a.affected]),
      [["codex", ["sales"]]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins reports updated when upstream content changed", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    // Bump only `sales` upstream.
    writeNativeMarket(remote, ["sales"], "2.0.0");

    const { remote: results } = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    assert.deepEqual(results[0]!.updated, ["sales"]);
    assert.deepEqual(results[0]!.unchanged, ["finance"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins reports a plugin deleted upstream and leaves it installed", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    deleteFromMarket(remote, "finance");

    const { remote: results } = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    assert.deepEqual(results[0]!.deleted, ["finance"]);
    assert.deepEqual(results[0]!.unchanged, ["sales"]);
    // Reporting only: the locally installed copy is not auto-removed.
    assert.deepEqual(lockNames(pluginsDir), ["finance", "sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins --all installs newly available plugins; default does not", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    // A new plugin appears upstream.
    writeNativeMarket(remote, ["sales", "ops"]);

    const { remote: r1 } = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    assert.deepEqual(r1[0]!.available, ["ops"]);
    assert.deepEqual(lockNames(pluginsDir), ["sales"], "default update does not install new ones");

    await updatePlugins({ pluginsDir, all: true, targets: ["codex"], gitRunner });
    assert.deepEqual(lockNames(pluginsDir), ["ops", "sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins surfaces a source that cannot be fetched", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner: fakeClone(remote) });

    const boom: GitRunner = () => {
      throw new Error("network down");
    };
    const { remote: results } = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner: boom });
    assert.equal(results[0]!.failed !== undefined, true, "failure is recorded, not thrown");
    assert.deepEqual(results[0]!.updated, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins rescans local-source plugins in place", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "alpha", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: join(src, "alpha"), pluginsDir, targets: ["codex"] });

    // No content change → local rescan reports unchanged.
    const { local } = await updatePlugins({ pluginsDir, targets: ["codex"] });
    assert.deepEqual(
      local.results.map((r) => ({ name: r.name, changed: r.changed })),
      [{ name: "alpha", changed: false }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
