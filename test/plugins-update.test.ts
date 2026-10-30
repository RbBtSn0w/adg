import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initPlugin } from "../src/commands/init.ts";
import { addPlugins } from "../src/commands/install.ts";
import type { GitRunner } from "../src/sources.ts";
import type { Agent } from "../src/agents/index.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import type { UpdatePhase } from "../src/render/progress.ts";
import { readLock, writeLock } from "../src/lock.ts";
import { installedPluginDir, lockPath } from "../src/paths.ts";
import { renderUpdateReport } from "../src/render/plugins.ts";
import { agentCommandOutcome } from "../src/command-outcome.ts";

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
  installed?: string[],
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
    listInstalled: installed ? () => installed : undefined,
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

test("updatePlugins distinguishes lockstep release versions from component changes", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    const pluginsDir = join(root, "pdir");
    for (const name of ["sales", "finance"]) {
      initPlugin({ name, dir: remote });
      const skill = join(remote, name, "skills", "demo");
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nOriginal\n");
    }
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner, agents: [] });
    for (const name of ["sales", "finance"]) {
      const path = join(remote, name, ".agents", ".plugin.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.version = "2.0.0";
      writeFileSync(path, JSON.stringify(manifest));
    }
    writeFileSync(join(remote, "sales", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nUpdated\n");
    const calls: { id: string; plugins: string[] }[] = [];
    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner,
      revisionResolver: () => "r2", activate: true, agents: [recordingAgent("codex", calls)] });
    assert.equal(result.remote[0]!.failed, undefined);
    const changes = result.remote[0]!.changes!;
    assert.equal(changes.find((change) => change.name === "finance")?.version, true);
    assert.equal(changes.find((change) => change.name === "finance")?.content, false);
    assert.equal(changes.find((change) => change.name === "sales")?.content, true);
    assert.deepEqual(calls.flatMap((call) => call.plugins).sort(), ["finance", "sales"]);
    const lines = renderUpdateReport(result).join("\n");
    assert.match(lines, /version only.*finance/);
    assert.match(lines, /content\/configuration.*sales/);
    assert.doesNotMatch(lines, /runtime.*synced/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("updatePlugins checkpoints unchanged monorepo members to avoid a second clone", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    let clones = 0;
    const gitRunner: GitRunner = (args) => { clones++; cpSync(remote, args.at(-1)!, { recursive: true }); };
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, gitRunner, agents: [] });
    const initial = readLock(lockPath(pluginsDir));
    for (const entry of Object.values(initial.plugins)) entry.resolvedRevision = "r1";
    writeLock(lockPath(pluginsDir), initial);
    writeNativeMarket(remote, ["sales"], "2.0.0");
    const options = { pluginsDir, gitRunner, agents: [], revisionResolver: () => "r2" };
    clones = 0;
    await updatePlugins(options);
    assert.equal(clones, 1);
    const after = readLock(lockPath(pluginsDir));
    assert.equal(after.plugins.finance!.resolvedRevision, "r2");
    assert.equal(after.plugins.finance!.updatedAt, initial.plugins.finance!.updatedAt);
    await updatePlugins(options);
    assert.equal(clones, 1, "the second check must use the verified repository checkpoint");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("updatePlugins keeps source version updates distinct from runtime sync failures", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, gitRunner, agents: [] });
    writeNativeMarket(remote, ["sales"], "2.0.0");
    const agent = recordingAgent("codex", []);
    agent.refresh = () => ({ agent: "codex", affected: [], skipped: false,
      failures: [{ plugin: "sales", stage: "install", errorType: "test_failure", message: "refresh failed" }] });
    const result = await updatePlugins({ pluginsDir, gitRunner, agents: [agent], activate: true, revisionResolver: () => "r2" });
    assert.equal(readLock(lockPath(pluginsDir)).plugins.sales!.version, "2.0.0");
    assert.equal(result.remote[0]!.changes?.[0]?.version, true);
    assert.deepEqual(result.agents[0]!.affected, []);
    assert.equal(result.agents[0]!.failures?.[0]?.message, "refresh failed");
    assert.equal(agentCommandOutcome(result.agents[0]!).exitCode, 1);
    assert.doesNotMatch(renderUpdateReport(result).join("\n"), /runtime.*synced|runtime.*updated/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("updatePlugins refreshes disabled local source files without enabling a runtime", async () => {
  const root = scratch();
  try {
    const source = initPlugin({ name: "sales", dir: join(root, "source") }).pluginDir;
    const pluginsDir = join(root, "pdir");
    await addPlugins({ spec: source, pluginsDir, targets: ["codex"], agents: [] });
    const lock = readLock(lockPath(pluginsDir));
    lock.plugins.sales!.state = "disabled";
    writeLock(lockPath(pluginsDir), lock);
    writeFileSync(join(source, "skills/getting-started/SKILL.md"), "---\nname: getting-started\ndescription: Local skill\n---\nUpdated\n");
    const calls: { id: string; plugins: string[] }[] = [];
    const result = await updatePlugins({ pluginsDir, targets: ["codex"], activate: true,
      agents: [recordingAgent("codex", calls)] });
    assert.equal(result.local.results[0]!.changes?.content, true);
    assert.equal(result.local.results[0]!.changed, true);
    assert.deepEqual(calls, []);
    assert.equal(readLock(lockPath(pluginsDir)).plugins.sales!.state, "disabled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("updatePlugins retains unselected source changes without unnecessary runtime refresh", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    const source = initPlugin({ name: "sales", dir: remote }).pluginDir;
    const unselected = join(source, "skills", "unselected");
    mkdirSync(unselected, { recursive: true });
    writeFileSync(join(unselected, "SKILL.md"), "---\nname: unselected\ndescription: Optional skill\n---\nOriginal\n");
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"],
      skillsSubset: ["getting-started"], gitRunner, agents: [] });
    writeFileSync(join(unselected, "SKILL.md"), "---\nname: unselected\ndescription: Optional skill\n---\nUpdated\n");
    const calls: { id: string; plugins: string[] }[] = [];
    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner, activate: true,
      revisionResolver: () => "r2", agents: [recordingAgent("codex", calls)] });
    assert.equal(result.remote[0]!.failed, undefined);
    assert.equal(result.remote[0]!.changes?.[0]?.content, true);
    assert.equal(result.remote[0]!.changes?.[0]?.runtimeRefreshRequired, false);
    assert.deepEqual(calls, []);
    const entry = readLock(lockPath(pluginsDir)).plugins.sales!;
    assert.equal(entry.resolvedRevision, "r2");
    assert.equal(existsSync(join(installedPluginDir(pluginsDir, "sales", entry.origin), "skills/unselected")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("updatePlugins treats a GitHub marketplace key as remote when a matching CWD path exists", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    mkdirSync(join(root, "acme", "market"), { recursive: true });
    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner, cwd: root });
    assert.deepEqual(result.remote[0]!.unchanged, ["sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins preserves a remote Default DSL identity when a matching CWD path exists", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    mkdirSync(join(remote, "skills", "demo"), { recursive: true });
    writeFileSync(join(remote, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", ref: "v1", pluginsDir, targets: ["codex"], gitRunner });
    const name = lockNames(pluginsDir)[0]!;

    mkdirSync(join(root, "acme", "market"), { recursive: true });
    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner, cwd: root });
    assert.equal(result.remote[0]!.failed, undefined);
    assert.deepEqual(result.remote[0]!.unchanged, [name]);
    assert.deepEqual(readLock(lockPath(pluginsDir)).plugins[name]!.origin, {
      type: "github", repo: "acme/market", ref: "v1", path: ".",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins --all preserves a remote Default DSL alias", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    mkdirSync(join(remote, "skills", "demo"), { recursive: true });
    writeFileSync(join(remote, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({
      spec: "acme/market",
      as: "custom-skills",
      defaultDescription: "Custom skills.",
      pluginsDir,
      targets: ["codex"],
      gitRunner,
    });

    const result = await updatePlugins({ pluginsDir, all: true, targets: ["codex"], gitRunner });
    assert.equal(result.remote[0]!.failed, undefined);
    assert.deepEqual(lockNames(pluginsDir), ["custom-skills"]);
    assert.deepEqual(result.remote[0]!.unchanged, ["custom-skills"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("updatePlugins migrates a remote Default DSL alias to a matching explicit plugin", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    mkdirSync(join(remote, "skills", "demo"), { recursive: true });
    writeFileSync(join(remote, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({
      spec: "acme/market",
      as: "asc",
      pluginsDir,
      only: ["skills"],
      targets: ["codex"],
      gitRunner,
    });

    mkdirSync(join(remote, ".claude-plugin"), { recursive: true });
    writeFileSync(join(remote, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "asc",
      version: "1.0.0",
      description: "Explicit ASC plugin.",
      skills: "./skills/",
    }));

    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    const entry = readLock(lockPath(pluginsDir)).plugins.asc!;
    assert.equal(result.remote[0]!.failed, undefined);
    assert.deepEqual(result.remote[0]!.updated, ["asc"]);
    assert.equal(entry.version, "1.0.0");
    assert.equal(entry.definition, undefined);
    assert.deepEqual(entry.selection, { components: ["skills"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("updatePlugins refuses a Default DSL migration when the explicit plugin identity differs", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    mkdirSync(join(remote, "skills", "demo"), { recursive: true });
    writeFileSync(join(remote, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", as: "asc", pluginsDir, targets: ["codex"], gitRunner });

    mkdirSync(join(remote, ".claude-plugin"), { recursive: true });
    writeFileSync(join(remote, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "different-plugin",
      version: "1.0.0",
      description: "Different plugin.",
      skills: "./skills/",
    }));

    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    assert.match(result.remote[0]!.failed ?? "", /none match the installed identity "asc"/);
    assert.deepEqual(lockNames(pluginsDir), ["asc"]);
    assert.equal(readLock(lockPath(pluginsDir)).plugins.asc!.definition?.as, "asc");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("updatePlugins avoids cloning when a revision probe matches the stored revision", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    let clones = 0;
    const gitRunner: GitRunner = (args) => { clones++; cpSync(remote, args[args.length - 1]!, { recursive: true }); };
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, gitRunner });
    const lock = readLock(lockPath(pluginsDir));
    lock.plugins.sales!.resolvedRevision = "abc";
    writeLock(lockPath(pluginsDir), lock);
    clones = 0;
    const result = await updatePlugins({ pluginsDir, gitRunner, revisionResolver: () => "abc" });
    assert.equal(clones, 0);
    assert.deepEqual(result.remote[0]!.unchanged, ["sales"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const beforeHashes = { sales: before.sales!.sourceHash, finance: before.finance!.sourceHash };

    // Source is byte-identical; a later `now` would be written only if we re-installed.
    await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner, now: "2026-09-09T00:00:00Z" });

    const after = readLock(lockPath(pluginsDir)).plugins;
    assert.equal(after.sales!.updatedAt, beforeStamps.sales, "unchanged plugin keeps its updatedAt");
    assert.equal(after.finance!.updatedAt, beforeStamps.finance, "unchanged plugin keeps its updatedAt");
    assert.equal(after.sales!.sourceHash, beforeHashes.sales);
    assert.equal(after.finance!.sourceHash, beforeHashes.finance);
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

test("updatePlugins updates disabled payload without activating it", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });
    const lock = readLock(lockPath(pluginsDir));
    lock.plugins.sales!.state = "disabled";
    writeLock(lockPath(pluginsDir), lock);

    writeNativeMarket(remote, ["sales"], "2.0.0");
    const calls: { id: string; plugins: string[] }[] = [];
    const result = await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgent("codex", calls)],
    });

    assert.deepEqual(result.remote[0]!.updated, ["sales"]);
    assert.equal(readLock(lockPath(pluginsDir)).plugins.sales!.state, "disabled");
    assert.deepEqual(calls, []);
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

    // Re-adding an already-installed plugin is also an update from an agent's
    // perspective: Claude's install command is a no-op for existing plugins, so
    // cached agents must be refreshed to re-pull the store copy.
    const readdCalls: { id: string; method: "activate" | "refresh"; plugins: string[] }[] = [];
    await addPlugins({
      spec: "acme/market",
      pluginsDir,
      all: true,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgentByMethod("codex", readdCalls)],
    });
    assert.deepEqual(
      readdCalls,
      [{ id: "codex", method: "refresh", plugins: ["finance", "sales"] }],
      "explicit re-add refreshes existing plugins so cached agents re-pull",
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

test("add refreshes an agent-only stale install even when the ADG store is new", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["apple-skills"], "1.13.2");
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    const calls: { id: string; method: "activate" | "refresh"; plugins: string[] }[] = [];

    await addPlugins({
      spec: "acme/market",
      pluginsDir,
      all: true,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgentByMethod("codex", calls, ["apple-skills"])],
    });

    assert.deepEqual(
      calls,
      [{ id: "codex", method: "refresh", plugins: ["apple-skills"] }],
      "agent-only stale installs must refresh because install is a no-op in cached agents",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add activates when an existing ADG plugin was manually removed from the agent", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["apple-skills"], "1.13.2");
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);

    await addPlugins({
      spec: "acme/market",
      pluginsDir,
      all: true,
      targets: ["codex"],
      gitRunner,
      activate: false,
    });

    const calls: { id: string; method: "activate" | "refresh"; plugins: string[] }[] = [];
    await addPlugins({
      spec: "acme/market",
      pluginsDir,
      all: true,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgentByMethod("codex", calls, [])],
    });

    assert.deepEqual(
      calls,
      [{ id: "codex", method: "activate", plugins: ["apple-skills"] }],
      "when live agent state is available, a missing agent install should be activated",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins --all activates brand-new plugins but refreshes updated ones", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    // Bump an installed plugin (→ refresh) and introduce a brand-new one (→ activate,
    // never refresh — refreshing a never-installed plugin would uninstall nothing
    // and warn/error in agents like Claude).
    writeNativeMarket(remote, ["sales"], "2.0.0");
    writeNativeMarket(remote, ["ops"]);

    const calls: { id: string; method: "activate" | "refresh"; plugins: string[] }[] = [];
    await updatePlugins({
      pluginsDir,
      all: true,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [recordingAgentByMethod("codex", calls)],
    });

    assert.deepEqual(
      calls.find((c) => c.method === "activate"),
      { id: "codex", method: "activate", plugins: ["ops"] },
      "brand-new plugin is activated, not refreshed",
    );
    assert.deepEqual(
      calls.find((c) => c.method === "refresh"),
      { id: "codex", method: "refresh", plugins: ["sales"] },
      "updated plugin is refreshed",
    );
    assert.equal(calls.length, 2, "no extra lifecycle calls (finance unchanged)");
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

test("updatePlugins removes a plugin deleted upstream from the same source", async () => {
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
    assert.deepEqual(lockNames(pluginsDir), ["sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins refreshes remaining skills after a skill is deleted upstream", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    for (const name of ["retired", "retained"]) {
      mkdirSync(join(remote, "sales", "skills", name), { recursive: true });
      writeFileSync(join(remote, "sales", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Example skill\n---\nOriginal instructions\n`);
    }
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    const installedSkills = join(installedPluginDir(pluginsDir, "sales", readLock(lockPath(pluginsDir)).plugins.sales!.origin), "skills");
    assert.equal(existsSync(join(installedSkills, "retired", "SKILL.md")), true);
    rmSync(join(remote, "sales", "skills", "retired"), { recursive: true });
    const updatedSkill = "---\nname: retained\ndescription: Example skill\n---\nUpdated instructions\n";
    writeFileSync(join(remote, "sales", "skills", "retained", "SKILL.md"), updatedSkill);

    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    assert.equal(result.remote[0]!.failed, undefined);
    assert.deepEqual(result.remote[0]!.updated, ["sales"]);
    assert.equal(existsSync(join(installedSkills, "retired")), false);
    assert.equal(readFileSync(join(installedSkills, "retained", "SKILL.md"), "utf8"), updatedSkill);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins deactivates upstream-deleted plugins from every mapped agent", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales", "finance"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });
    deleteFromMarket(remote, "finance");

    const calls: { id: string; plugins: string[] }[] = [];
    const fake = (id: string): Agent => ({
      id,
      displayName: id,
      adaptTarget: "codex",
      detect: () => true,
      available: () => true,
      activate: () => ({ agent: id, affected: [], skipped: false }),
      refresh: () => ({ agent: id, affected: [], skipped: false }),
      deactivate: (ctx) => {
        calls.push({ id, plugins: ctx.plugins });
        return { agent: id, affected: ctx.plugins, skipped: false };
      },
    });

    await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents: [fake("codex")],
      deactivationAgents: [fake("claude"), fake("codex"), fake("antigravity")],
    });

    assert.deepEqual(calls.map((c) => [c.id, c.plugins]), [
      ["claude", ["finance"]],
      ["codex", ["finance"]],
      ["antigravity", ["finance"]],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("addPlugins prunes stale names when a remote source changes from one plugin to a marketplace", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["apple-skills"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "RbBtSn0w/apple-skills", pluginsDir, all: true, targets: ["codex"], gitRunner });
    assert.deepEqual(lockNames(pluginsDir), ["apple-skills"]);

    deleteFromMarket(remote, "apple-skills");
    writeNativeMarket(remote, ["app-develop", "xcode"]);

    const result = await addPlugins({ spec: "RbBtSn0w/apple-skills", pluginsDir, all: true, targets: ["codex"], gitRunner });
    assert.deepEqual(result.removed, ["apple-skills"]);
    assert.deepEqual(result.order, ["app-develop", "xcode"]);
    assert.deepEqual(lockNames(pluginsDir), ["app-develop", "xcode"]);
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
    const testTmp = join(root, "tmp");
    mkdirSync(testTmp);
    const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      process.env.TMPDIR = testTmp;
      process.env.TMP = testTmp;
      process.env.TEMP = testTmp;
      const { remote: results } = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner: boom });
      assert.equal(results[0]!.failed !== undefined, true, "failure is recorded, not thrown");
      assert.deepEqual(results[0]!.updated, []);
      assert.deepEqual(readdirSync(testTmp).filter((name) => name.startsWith("adg-")), [], "failed ADG checkouts are removed before reporting the source failure");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

// The silent stretch between the scope prompt and the final report is what made
// `plugins update` feel hung. These assert the events exist at the points that
// actually block, not merely that a callback is reachable.
test("updatePlugins reports a check phase before probing each remote", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    const phases: UpdatePhase[] = [];
    await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      onProgress: (phase) => phases.push(phase),
    });

    const check = phases.find((p) => p.kind === "check");
    assert.ok(check, "expected a check phase for the blocking remote probe");
    assert.equal(check.kind === "check" && check.source, "acme/market");
    assert.equal(check.kind === "check" && check.total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins reports fetch and install phases when the revision moved", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    const phases: UpdatePhase[] = [];
    await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      // A revision that differs from the lock forces the clone path rather than
      // the unchanged fast path.
      revisionResolver: () => "0".repeat(40),
      onProgress: (phase) => phases.push(phase),
    });

    const kinds = phases.map((p) => p.kind);
    assert.ok(kinds.includes("fetch"), `expected a fetch phase, saw ${kinds.join(", ")}`);
    assert.ok(kinds.includes("install"), `expected an install phase, saw ${kinds.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins reports an activate phase for the agent re-sync", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    const calls: { id: string; plugins: string[] }[] = [];
    const agents = [recordingAgent("codex", calls)];
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner, agents });

    // Re-activation only runs for plugins that actually changed, so move the
    // upstream version — otherwise there is legitimately nothing to re-sync.
    writeNativeMarket(remote, ["sales"], "2.0.0");

    const phases: UpdatePhase[] = [];
    await updatePlugins({
      pluginsDir,
      targets: ["codex"],
      gitRunner,
      activate: true,
      agents,
      revisionResolver: () => "0".repeat(40),
      onProgress: (phase) => phases.push(phase),
    });

    // Agent re-activation spawns agent CLIs per plugin and dominates wall clock;
    // it is the phase most worth showing.
    const activate = phases.find((p) => p.kind === "activate");
    assert.ok(activate, `expected an activate phase, saw ${phases.map((p) => p.kind).join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePlugins runs unchanged when no progress sink is supplied", async () => {
  const root = scratch();
  try {
    const remote = join(root, "remote");
    writeNativeMarket(remote, ["sales"]);
    const pluginsDir = join(root, "pdir");
    const gitRunner = fakeClone(remote);
    await addPlugins({ spec: "acme/market", pluginsDir, all: true, targets: ["codex"], gitRunner });

    const result = await updatePlugins({ pluginsDir, targets: ["codex"], gitRunner });
    assert.deepEqual(result.remote[0]!.unchanged, ["sales"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
