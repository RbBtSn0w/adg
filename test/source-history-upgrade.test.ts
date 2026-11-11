import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPlugins } from "../src/commands/install.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import { readLock } from "../src/lock.ts";
import { installedPluginDir, lockPath } from "../src/paths.ts";
import type { Agent, AgentPluginRecord } from "../src/agents/index.ts";
import { UpdateCancelled } from "../src/commands/source-upgrade.ts";
import { claudeAgent, claudeMarketplaceName, parseClaudePluginListJson, parseClaudePluginRecords, runClaudeLifecycle } from "../src/agents/claude.ts";

function plugin(root: string, name: string, skills: string[], hooks = false): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name, version: "1.0.0", description: name }));
  for (const skill of skills) {
    mkdirSync(join(dir, "skills", skill), { recursive: true });
    writeFileSync(join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill}\n---\nReusable skill.\n`);
  }
  if (hooks) {
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo approved" }] }] } }));
  }
  return dir;
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "adg-history-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const pluginsDir = join(root, "store");
  const gitRunner = (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); };
  const spec = "thirdparty/ordinary";
  return { root, remote, pluginsDir, gitRunner, spec };
}

test("one-time --all preserves reviewed skills-only selection for a new executable plugin", async (t) => {
  const s = setup(t);
  plugin(s.remote, "first", ["one"]);
  await addPlugins({ ...s, plugins: ["first"], only: ["skills"], targets: ["claude"], agents: [] });
  plugin(s.remote, "second", ["two"], true);
  const result = await updatePlugins({ ...s, all: true, targets: ["claude"], agents: [] });
  assert.equal(result.remote[0]?.failed, undefined);
  assert.equal(result.remote[0]?.actionRequired, undefined);
  const entry = readLock(lockPath(s.pluginsDir)).plugins.second!;
  assert.deepEqual(entry.selection?.components, ["skills"]);
  const dir = installedPluginDir(s.pluginsDir, "second", entry.origin);
  assert.ok(existsSync(join(dir, "skills/two/SKILL.md")));
  assert.equal(existsSync(join(dir, "hooks/hooks.json")), false);
});

test("a third-party skill relocates without any ADG publisher file and update converges", async (t) => {
  const s = setup(t);
  const old = plugin(s.remote, "former", ["inspect"]);
  await addPlugins({ ...s, plugins: ["former"], agents: [] });
  rmSync(old, { recursive: true });
  plugin(s.remote, "current", ["inspect", "unrelated"]);
  const updated = await updatePlugins({ ...s, agents: [] });
  assert.equal(updated.remote[0]?.failed, undefined);
  assert.equal(updated.remote[0]?.actionRequired, undefined);
  const lock = readLock(lockPath(s.pluginsDir));
  assert.deepEqual(Object.keys(lock.plugins), ["current"]);
  assert.deepEqual(lock.plugins.current?.selection?.skills, ["inspect"]);
  assert.equal(existsSync(join(s.remote, ".agents")), false);
  const repeated = await updatePlugins({ ...s, agents: [], review: async () => { throw new Error("Unexpected repeated decision"); } });
  assert.deepEqual(repeated.remote[0]?.updated, []);
  assert.deepEqual(repeated.remote[0]?.unchanged, ["current"]);
});

test("native marketplace rename chains carry a plugin across a changed skill name", async (t) => {
  const s = setup(t);
  plugin(s.remote, "former", ["before"]);
  await addPlugins({ ...s, agents: [] });
  rmSync(join(s.remote, "former"), { recursive: true });
  plugin(s.remote, "current", ["after"]);
  mkdirSync(join(s.remote, ".claude-plugin"));
  writeFileSync(join(s.remote, ".claude-plugin/marketplace.json"), JSON.stringify({
    name: "ordinary", owner: { name: "Example" }, plugins: [{ name: "current", source: "./current" }],
    renames: { former: "middle", middle: "current" },
  }));
  const result = await updatePlugins({ ...s, agents: [] });
  assert.equal(result.remote[0]?.failed, undefined);
  assert.equal(result.remote[0]?.actionRequired, undefined);
  assert.deepEqual(Object.keys(readLock(lockPath(s.pluginsDir)).plugins), ["current"]);
});

test("an empty third-party catalog can retire its last plugin inside update", async (t) => {
  const s = setup(t);
  plugin(s.remote, "former", ["inspect"]);
  await addPlugins({ ...s, agents: [] });
  rmSync(join(s.remote, "former"), { recursive: true });
  const result = await updatePlugins({ ...s, agents: [], review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, { action: "drop" as const }])), allow: [],
  }) });
  assert.deepEqual(result.remote[0]?.deleted, ["former"]);
  assert.deepEqual(readLock(lockPath(s.pluginsDir)).plugins, {});
});

test("catalog removal is recognized even when the old plugin files remain in the repository", async t => {
  const s = setup(t);
  plugin(s.remote, "former", ["inspect"]);
  mkdirSync(join(s.remote, ".claude-plugin"));
  const catalog = join(s.remote, ".claude-plugin/marketplace.json");
  writeFileSync(catalog, JSON.stringify({ name: "ordinary", plugins: [{ name: "former", source: "./former" }] }));
  await addPlugins({ ...s, agents: [] });
  writeFileSync(catalog, JSON.stringify({ name: "ordinary", plugins: [] }));
  const result = await updatePlugins({ ...s, agents: [], review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, { action: "keep" as const }])), allow: [],
  }) });
  assert.deepEqual(result.remote[0]?.retained, ["former"]);
  assert.ok(readLock(lockPath(s.pluginsDir)).plugins.former);
});

test("a partly matching structural catalog leaves every alias untouched", async (t) => {
  const s = setup(t);
  mkdirSync(join(s.remote, "hooks"));
  const hooks = join(s.remote, "hooks/hooks.json");
  writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo before" }] }] } }));
  for (const as of ["first", "second"]) {
    await addPlugins({ ...s, as, only: ["hooks"], targets: ["claude"], agents: [], sparse: ["hooks"] });
  }
  const before = readFileSync(lockPath(s.pluginsDir), "utf8");
  mkdirSync(join(s.remote, ".claude-plugin"));
  writeFileSync(join(s.remote, ".claude-plugin/plugin.json"), JSON.stringify({ name: "first", version: "2.0.0", description: "First" }));
  writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo changed" }] }] } }));
  const result = await updatePlugins({ ...s, agents: [], targets: ["claude"] });
  assert.match(result.remote[0]?.failed ?? result.remote[0]?.actionRequired?.join(" ") ?? "", /identity|identities|alias/i);
  assert.equal(readFileSync(lockPath(s.pluginsDir), "utf8"), before);
});

test("--all requires approval before an unrestricted source can gain a new hook plugin", async (t) => {
  const s = setup(t);
  plugin(s.remote, "first", ["one"]);
  await addPlugins({ ...s, plugins: ["first"], targets: ["claude"], agents: [] });
  plugin(s.remote, "second", ["two"], true);
  const before = readFileSync(lockPath(s.pluginsDir), "utf8");
  const unattended = await updatePlugins({ ...s, all: true, targets: ["claude"], agents: [] });
  assert.match(unattended.remote[0]?.actionRequired?.join(" ") ?? "", /Approval required.*second/);
  assert.equal(readFileSync(lockPath(s.pluginsDir), "utf8"), before);
  const approved = await updatePlugins({ ...s, all: true, targets: ["claude"], agents: [], review: async ({ executable }) => ({
    history: {}, allow: executable.map(item => item.key),
  }) });
  assert.equal(approved.remote[0]?.actionRequired, undefined);
  const entry = readLock(lockPath(s.pluginsDir)).plugins.second!;
  assert.ok(existsSync(join(installedPluginDir(s.pluginsDir, "second", entry.origin), "hooks/hooks.json")));
});

test("sequential sparse installs reconcile both third-party siblings against a complete catalog", async (t) => {
  const s = setup(t);
  plugin(s.remote, "first", ["one"]);
  plugin(s.remote, "second", ["two"]);
  const gitRunner = (args: string[]) => {
    if (args[0] === "clone") {
      if (args.includes("--sparse")) mkdirSync(args.at(-1)!, { recursive: true });
      else cpSync(s.remote, args.at(-1)!, { recursive: true });
    } else if (args[2] === "sparse-checkout") {
      for (const path of args.slice(4)) cpSync(join(s.remote, path), join(args[1]!, path), { recursive: true });
    }
  };
  for (const name of ["first", "second"]) await addPlugins({ ...s, gitRunner, sparse: [name], plugins: [name], agents: [] });
  const result = await updatePlugins({ ...s, gitRunner, agents: [] });
  assert.equal(result.remote[0]?.actionRequired, undefined);
  assert.equal(result.remote[0]?.missingUpstream, undefined);
  assert.deepEqual(Object.keys(readLock(lockPath(s.pluginsDir)).plugins).sort(), ["first", "second"]);
  assert.equal(existsSync(join(s.remote, ".agents")), false);
});

function runtime(pluginsDir: string) {
  const native = new Map<string, AgentPluginRecord>([
    ["first", { id: "first", name: "first", installed: true, enabled: true, version: "1.0.0" }],
    ["second", { id: "second", name: "second", installed: true, enabled: false, version: "1.0.0" }],
  ]);
  const calls: string[] = [];
  let available = true;
  const install: Agent["activate"] = ctx => {
    const lock = readLock(lockPath(pluginsDir));
    for (const name of ctx.plugins) {
      calls.push(name);
      native.set(name, { id: name, name, installed: true, enabled: true, version: lock.plugins[name]!.version });
    }
    return { agent: "codex", affected: ctx.plugins, skipped: false };
  };
  const agent: Agent = {
    id: "codex", displayName: "Codex", adaptTarget: "codex", detect: () => true, available: () => available,
    retrySafeOperations: ["activate", "refresh", "deactivate"],
    inspectPlugins: () => [...native.values()], listInstalled: () => [...native.values()].filter(p => p.enabled).map(p => p.name),
    activate: install, refresh: install,
    deactivate: ctx => { for (const name of ctx.plugins) native.delete(name); return { agent: "codex", affected: ctx.plugins, skipped: false }; },
  };
  return { agent, calls, native, setAvailable: (value: boolean) => { available = value; } };
}

async function splitSetup(t: TestContext) {
  const s = setup(t);
  plugin(s.remote, "first", ["one"]);
  plugin(s.remote, "second", ["two"]);
  await addPlugins({ ...s, all: true, agents: [] });
  rmSync(join(s.remote, "first"), { recursive: true });
  rmSync(join(s.remote, "second"), { recursive: true });
  plugin(s.remote, "merged", ["one", "two"]);
  return s;
}

test("update reviews mixed native states before publication and preserves disabled intent in later updates", async t => {
  const s = await splitSetup(t);
  const native = runtime(s.pluginsDir);
  const prompts: string[] = [];
  const result = await updatePlugins({ ...s, agents: [native.agent], activate: true, review: async ({ history }) => {
    prompts.push(...history.map(p => p.id));
    return { history: Object.fromEntries(history.map(p => [p.id, { action: "disabled" as const }])), allow: [] };
  } });
  assert.deepEqual(prompts, ["state:codex/merged"]);
  assert.equal(result.remote[0]?.pendingRuntime, undefined);
  assert.deepEqual(native.calls, []);
  assert.equal(readLock(lockPath(s.pluginsDir)).plugins.merged?.runtimeStates?.codex, false);
  const manifest = join(s.remote, "merged/.claude-plugin/plugin.json");
  writeFileSync(manifest, JSON.stringify({ name: "merged", version: "2.0.0", description: "Updated" }));
  const repeated = await updatePlugins({ ...s, agents: [native.agent], activate: true });
  assert.equal(repeated.remote[0]?.pendingRuntime, undefined);
  assert.deepEqual(native.calls, []);
});

test("a later available runtime resolves mixed state in the same offline update replay", async t => {
  const s = await splitSetup(t);
  const native = runtime(s.pluginsDir);
  native.setAvailable(false);
  const pending = await updatePlugins({ ...s, agents: [native.agent], activate: true });
  assert.ok(pending.remote[0]?.pendingRuntime?.length);
  assert.ok(readLock(lockPath(s.pluginsDir)).plugins.first);
  native.setAvailable(true);
  await assert.rejects(updatePlugins({ pluginsDir: s.pluginsDir, agents: [native.agent], activate: true,
    gitRunner: () => { throw new Error("Source is offline"); }, review: async () => undefined,
  }), error => error instanceof UpdateCancelled && Boolean(error.partial?.remote[0]?.pendingRuntime?.length));
  const result = await updatePlugins({ pluginsDir: s.pluginsDir, agents: [native.agent], activate: true,
    gitRunner: () => { throw new Error("Source is offline"); }, review: async ({ history }) => ({
      history: Object.fromEntries(history.map(p => [p.id, { action: "enabled" as const }])), allow: [],
    }) });
  assert.equal(result.remote[0]?.resumed, true);
  assert.equal(result.remote[0]?.pendingRuntime, undefined);
  assert.deepEqual(Object.keys(readLock(lockPath(s.pluginsDir)).plugins), ["merged"]);
  assert.deepEqual(native.calls, ["merged"]);
  assert.equal(native.native.get("merged")?.enabled, true);
});

test("ordinary update resumes the real Claude lifecycle after interruption before its first install", async t => {
  const s = setup(t);
  plugin(s.remote, "former", ["inspect", "unselected"]);
  await addPlugins({ ...s, plugins: ["former"], only: ["skills"], skillsSubset: ["inspect"], targets: ["claude"], agents: [] });
  rmSync(join(s.remote, "former"), { recursive: true });
  plugin(s.remote, "current", ["inspect", "unrelated"]);
  const marketplace = claudeMarketplaceName(s.pluginsDir);
  const native = new Set(["former"]);
  let installs = 0;
  const runner = (args: string[]) => {
    if (args[1] === "marketplace") return { ok: true, out: "[]" };
    if (args[1] === "list") return { ok: true, out: JSON.stringify([...native].map(name => ({
      id: `${name}@${marketplace}`, scope: "project", enabled: true, version: "1.0.0",
    }))) };
    const name = args[2]!.split("@")[0]!;
    if (args[1] === "install") {
      installs++;
      if (installs === 1) throw new Error("Process interrupted before native install");
      native.add(name);
    }
    if (args[1] === "uninstall") native.delete(name);
    return { ok: true, out: "" };
  };
  const agent: Agent = { ...claudeAgent, detect: () => true, available: () => true,
    inspectPlugins: ctx => parseClaudePluginRecords(runner(["plugin", "list", "--json"]).out, marketplace, ctx.scope),
    listInstalled: ctx => parseClaudePluginListJson(runner(["plugin", "list", "--json"]).out, marketplace, ctx.scope),
    activate: ctx => runClaudeLifecycle(ctx, "activate", runner, () => true),
    refresh: ctx => runClaudeLifecycle(ctx, "refresh", runner, () => true),
    deactivate: ctx => runClaudeLifecycle(ctx, "deactivate", runner, () => true),
  };
  const first = await updatePlugins({ ...s, agents: [agent], activate: true });
  assert.ok(first.remote[0]?.pendingRuntime?.length);
  assert.deepEqual([...native], ["former"]);
  assert.ok(readLock(lockPath(s.pluginsDir)).plugins.former);
  const recovered = await updatePlugins({ pluginsDir: s.pluginsDir, agents: [agent], activate: true,
    gitRunner: () => { throw new Error("Upstream is offline"); },
  });
  assert.equal(recovered.remote[0]?.resumed, true);
  assert.equal(recovered.remote[0]?.pendingRuntime, undefined);
  assert.deepEqual([...native], ["current"]);
  assert.deepEqual(Object.keys(readLock(lockPath(s.pluginsDir)).plugins), ["current"]);
  const entry = readLock(lockPath(s.pluginsDir)).plugins.current!;
  assert.deepEqual(entry.selection?.skills, ["inspect"]);
  assert.equal(existsSync(join(installedPluginDir(s.pluginsDir, "current", entry.origin), "skills/unrelated/SKILL.md")), false);
  assert.equal(installs, 2);
});
