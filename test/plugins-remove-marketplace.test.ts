import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initPlugin } from "../src/commands/init.ts";
import { addPlugins } from "../src/commands/install.ts";
import type { GitRunner } from "../src/sources.ts";
import { removePlugin } from "../src/commands/remove.ts";
import { updateLock } from "../src/commands/update.ts";
import { marketplaceList, marketplaceRemove, marketplaceUpgrade } from "../src/commands/marketplace.ts";
import type { Agent } from "../src/agents/index.ts";
import { readLock } from "../src/lock.ts";
import { readMarketplace } from "../src/marketplace.ts";
import { lockPath, marketplacePath } from "../src/paths.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "adg-rm-mp-"));
}

/** Write a marketplace of native Claude plugins (no .adg-plugin) under `dir`. */
function writeNativeMarket(dir: string, names: string[]): void {
  for (const name of names) {
    const d = join(dir, name, ".claude-plugin");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: name }));
  }
}

/** A gitRunner that serves `remote` as the fake clone for any spec. */
function fakeClone(remote: string): GitRunner {
  return (args) => cpSync(remote, args[args.length - 1]!, { recursive: true });
}

const lockNames = (pluginsDir: string) => Object.keys(readLock(lockPath(pluginsDir)).plugins).sort();

// ── add: unified discover → select → install ──

test("add installs the sole plugin in a source automatically", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "demo", dir: src });
    const pluginsDir = join(root, "pdir");
    const { installed } = await addPlugins({ spec: join(src, "demo"), pluginsDir, targets: ["codex"] });
    assert.deepEqual(installed.map((i) => i.name), ["demo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add --all installs every plugin in a multi-plugin source", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "alpha", dir: src });
    initPlugin({ name: "beta", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: src, pluginsDir, all: true, targets: ["codex"] });
    assert.deepEqual(lockNames(pluginsDir), ["alpha", "beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add --plugin installs only the named subset", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "alpha", dir: src });
    initPlugin({ name: "beta", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: src, pluginsDir, plugins: ["alpha"], targets: ["codex"] });
    assert.deepEqual(lockNames(pluginsDir), ["alpha"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add via interactive selectPlugins callback installs the picked plugins", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "alpha", dir: src });
    initPlugin({ name: "beta", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({
      spec: src,
      pluginsDir,
      targets: ["codex"],
      selectPlugins: (choices) => choices.filter((c) => c.name === "beta").map((c) => c.name),
    });
    assert.deepEqual(lockNames(pluginsDir), ["beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add on a multi-plugin source with no selection asks the user to choose", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "alpha", dir: src });
    initPlugin({ name: "beta", dir: src });
    await assert.rejects(
      () => addPlugins({ spec: src, pluginsDir: join(root, "pdir"), targets: ["codex"] }),
      /contains 2 plugins[\s\S]*--plugin[\s\S]*--all/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add auto-converts native Claude/Codex plugins", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    writeNativeMarket(src, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const { converted } = await addPlugins({ spec: src, pluginsDir, all: true, targets: ["codex"] });
    assert.deepEqual(converted.sort(), ["finance", "sales"]);
    assert.deepEqual(lockNames(pluginsDir), ["finance", "sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add (remote, injected clone) installs a native market with --all", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const gitRunner: GitRunner = (args) => cpSync(remote, args[args.length - 1]!, { recursive: true });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });
    assert.deepEqual(lockNames(pluginsDir), ["finance", "sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── remove ──

test("removePlugin deletes dir and drops it from lock + marketplace", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "demo", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: join(src, "demo"), pluginsDir, targets: ["codex"] });

    assert.ok(existsSync(join(pluginsDir, "demo")));
    assert.deepEqual(lockNames(pluginsDir), ["demo"]);

    const res = removePlugin({ pluginsDir, name: "demo" });
    assert.equal(res.removedFromLock, true);
    assert.equal(res.removedFromMarketplace, true);
    assert.ok(!existsSync(join(pluginsDir, "demo")));
    assert.deepEqual(lockNames(pluginsDir), []);
    assert.deepEqual(readMarketplace(marketplacePath(pluginsDir), "pdir").plugins, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removePlugin with deactivate uninstalls via the injected agents", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "demo", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: join(src, "demo"), pluginsDir, targets: ["codex"] });

    const calls: { id: string; op: string; plugins: string[]; scope: string }[] = [];
    const fake = (id: string): Agent => ({
      id,
      displayName: id,
      adaptTarget: "codex",
      detect: () => true,
      available: () => true,
      activate: () => ({ agent: id, affected: [], skipped: false }),
      deactivate: (ctx) => {
        calls.push({ id, op: "deactivate", plugins: ctx.plugins, scope: ctx.scope });
        return { agent: id, affected: ctx.plugins, skipped: false };
      },
      refresh: () => ({ agent: id, affected: [], skipped: false }),
    });

    const res = removePlugin({
      pluginsDir,
      name: "demo",
      deactivate: true,
      scope: "user",
      agents: [fake("claude"), fake("codex")],
    });

    assert.deepEqual(res.agents?.map((a) => [a.agent, a.affected]), [["claude", ["demo"]], ["codex", ["demo"]]]);
    assert.deepEqual(calls, [
      { id: "claude", op: "deactivate", plugins: ["demo"], scope: "user" },
      { id: "codex", op: "deactivate", plugins: ["demo"], scope: "user" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removePlugin without deactivate never touches the agents", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "demo", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: join(src, "demo"), pluginsDir, targets: ["codex"] });
    const res = removePlugin({ pluginsDir, name: "demo" });
    assert.equal(res.agents, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removePlugin errors when the plugin is not installed", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "pdir"), { recursive: true });
    assert.throws(() => removePlugin({ pluginsDir: join(root, "pdir"), name: "ghost" }), /not installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateLock with resync re-syncs changed plugins to both agents (injected)", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "demo", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: join(src, "demo"), pluginsDir, targets: ["codex"] });

    // Mutate packaged content (a declared skill) so update detects a change.
    // A non-payload file (e.g. NOTE.md) would be excluded by the packaging
    // allowlist and correctly not affect the hash.
    writeFileSync(join(pluginsDir, "demo", "skills", "getting-started", "SKILL.md"), "---\nname: getting-started\ndescription: changed.\n---\n");

    const calls: { id: string; plugins: string[] }[] = [];
    const fake = (id: string): Agent => ({
      id,
      displayName: id,
      adaptTarget: "codex",
      detect: () => true,
      available: () => true,
      activate: () => ({ agent: id, affected: [], skipped: false }),
      deactivate: () => ({ agent: id, affected: [], skipped: false }),
      refresh: (ctx) => {
        calls.push({ id, plugins: ctx.plugins });
        return { agent: id, affected: ctx.plugins, skipped: false };
      },
    });

    const out = updateLock(pluginsDir, undefined, {
      resync: true,
      scope: "project",
      agents: [fake("claude"), fake("codex")],
    });

    assert.deepEqual(out.agents?.map((a) => [a.agent, a.affected]), [["claude", ["demo"]], ["codex", ["demo"]]]);
    assert.deepEqual(calls, [{ id: "claude", plugins: ["demo"] }, { id: "codex", plugins: ["demo"] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── marketplace = installed plugins grouped by source (lock.origin view) ──

test("marketplace list groups installed plugins by source", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    // Install two plugins from a github source; their lock.origin shares the repo.
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner: fakeClone(remote) });

    const groups = marketplaceList({ pluginsDir });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.source, "acme/market");
    assert.equal(groups[0]!.remote, true);
    assert.deepEqual(groups[0]!.installed, ["finance", "sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marketplace upgrade refreshes installed and reports newly available", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance", "ops"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    // Install only two of the three the source offers.
    await addPlugins({ spec: "acme/market", pluginsDir, plugins: ["sales", "finance"], targets: ["codex"], gitRunner });

    const [res] = await marketplaceUpgrade({ pluginsDir, source: "acme/market", targets: ["codex"], gitRunner });
    assert.deepEqual(res!.updated.map((u) => u.name).sort(), ["finance", "sales"]);
    assert.deepEqual(res!.available, ["ops"], "the uninstalled plugin is surfaced");
    assert.deepEqual(lockNames(pluginsDir), ["finance", "sales"], "default upgrade does not install new ones");

    // --all also installs what's newly available.
    await marketplaceUpgrade({ pluginsDir, source: "acme/market", all: true, targets: ["codex"], gitRunner });
    assert.deepEqual(lockNames(pluginsDir), ["finance", "ops", "sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marketplace remove uninstalls every plugin from a source", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner: fakeClone(remote) });

    const res = marketplaceRemove({ pluginsDir, source: "acme/market" });
    assert.deepEqual(res.removed.sort(), ["finance", "sales"]);
    assert.deepEqual(lockNames(pluginsDir), []);
    assert.equal(marketplaceList({ pluginsDir }).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marketplace upgrade rejects a local source and unknown source", async () => {
  const root = scratch();
  try {
    const src = join(root, "src");
    initPlugin({ name: "alpha", dir: src });
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: join(src, "alpha"), pluginsDir, targets: ["codex"] });

    // alpha installed from a local path → grouped under "(local)", not re-syncable.
    assert.equal(marketplaceList({ pluginsDir })[0]!.remote, false);
    await assert.rejects(
      () => marketplaceUpgrade({ pluginsDir, source: "(local)" }),
      /local .*cannot be re-synced/,
    );
    await assert.rejects(() => marketplaceUpgrade({ pluginsDir, source: "nope/repo" }), /no installed source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
