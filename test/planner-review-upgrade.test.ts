import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPlugins } from "../src/commands/install.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import { readLock, writeLock } from "../src/lock.ts";
import { installedPluginDir, lockPath } from "../src/paths.ts";
import { installedHistory } from "../src/source-history.ts";

function plugin(root: string, name: string, version: string, skills: string[]): void {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name, version, description: name }));
  for (const skill of skills) {
    mkdirSync(join(dir, "skills", skill), { recursive: true });
    writeFileSync(join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill}\n---\nSynthetic public skill.\n`);
  }
}

test("removed selected skill requires approval even with --all, supports keep, and converges after drop", async t => {
  const root = mkdtempSync(join(tmpdir(), "adg-planner-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const options = { pluginsDir: join(root, "store"), spec: "example/public", agents: [],
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
  plugin(remote, "survivor", "1.0.0", ["a", "b", "unselected"]);
  plugin(remote, "peer", "1.0.0", ["peer-skill"]);
  await addPlugins({ ...options, plugins: ["survivor"], only: ["skills"], skillsSubset: ["a", "b"] });
  await addPlugins({ ...options, plugins: ["peer"], preserveExisting: true });
  assert.deepEqual(readLock(lockPath(options.pluginsDir)).plugins.survivor?.selection?.skills, ["a", "b"]);
  const before = readFileSync(lockPath(options.pluginsDir), "utf8");
  plugin(remote, "survivor", "2.0.0", ["b", "extra"]);
  plugin(remote, "peer", "2.0.0", ["peer-skill"]);

  const unattended = await updatePlugins({ ...options, all: true });
  assert.equal(unattended.remote[0]?.failed, undefined);
  assert.match(unattended.remote[0]?.actionRequired?.join(" ") ?? "", /drop:survivor:a/, JSON.stringify(unattended));
  assert.equal(readFileSync(lockPath(options.pluginsDir), "utf8"), before);

  const kept = await updatePlugins({ ...options, all: true, review: async ({ history }) => {
    assert.deepEqual(history, [{ id: "drop:survivor:a", skills: ["survivor:a"], choices: ["keep", "drop"] }]);
    return { history: { "drop:survivor:a": { action: "keep" } }, allow: [] };
  } });
  assert.equal(kept.remote[0]?.failed, undefined);
  assert.equal(kept.remote[0]?.actionRequired, undefined);
  assert.deepEqual(kept.remote[0]?.retained, ["survivor"]);
  const keptLock = readLock(lockPath(options.pluginsDir));
  assert.equal(keptLock.plugins.survivor?.version, "1.0.0");
  assert.equal(keptLock.plugins.peer?.version, "2.0.0");
  const preserved = keptLock.plugins.survivor!;
  assert.ok(existsSync(join(installedPluginDir(options.pluginsDir, "survivor", preserved.origin), "skills/a/SKILL.md")));

  const dropped = await updatePlugins({ ...options, all: true, review: async ({ history }) => {
    assert.deepEqual(history.map(item => item.id), ["drop:survivor:a"]);
    return { history: { "drop:survivor:a": { action: "drop" } }, allow: [] };
  } });
  assert.equal(dropped.remote[0]?.failed, undefined);
  assert.equal(dropped.remote[0]?.actionRequired, undefined);
  const entry = readLock(lockPath(options.pluginsDir)).plugins.survivor!;
  assert.equal(entry.version, "2.0.0");
  assert.deepEqual(entry.selection?.skills, ["b"]);
  const installed = installedPluginDir(options.pluginsDir, "survivor", entry.origin);
  assert.ok(existsSync(join(installed, "skills/b/SKILL.md")));
  for (const skill of ["a", "extra"]) assert.equal(existsSync(join(installed, "skills", skill, "SKILL.md")), false);
  const repeated = await updatePlugins({ ...options, all: true,
    review: async () => { throw new Error("Unexpected repeated review"); } });
  assert.equal(repeated.remote[0]?.failed, undefined);
  assert.deepEqual(repeated.remote[0]?.updated, []);
  assert.deepEqual(repeated.remote[0]?.unchanged?.sort(), ["peer", "survivor"]);
});

test("dropping a legacy skill cannot install agents absent from verified installed bytes", async t => {
  const root = mkdtempSync(join(tmpdir(), "adg-planner-legacy-drop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const options = { pluginsDir: join(root, "store"), spec: "example/public-legacy-drop", agents: [],
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
  const upstream = (version: string, skills: string[]) => {
    plugin(remote, "survivor", version, skills);
    mkdirSync(join(remote, "survivor", "agents"));
    writeFileSync(join(remote, "survivor", "agents", "unselected.md"), "---\nname: unselected\ndescription: Synthetic agent\n---\nSynthetic public agent.\n");
  };
  upstream("1.0.0", ["a", "b", "extra"]);
  await addPlugins({ ...options, plugins: ["survivor"], only: ["skills"], skillsSubset: ["a", "b"] });
  const legacy = readLock(lockPath(options.pluginsDir));
  delete legacy.plugins.survivor!.selection;
  legacy.plugins.survivor!.selectionKnown = false;
  delete legacy.sources;
  writeLock(lockPath(options.pluginsDir), legacy);
  assert.deepEqual(installedHistory(options.pluginsDir, legacy, options.spec)[0]?.effectiveSelection,
    { components: ["skills"], skills: ["a", "b"] });

  upstream("2.0.0", ["b", "extra"]);
  const result = await updatePlugins({ ...options, review: async ({ history }) => {
    assert.deepEqual(history.map(item => item.id), ["drop:survivor:a"]);
    return { history: { "drop:survivor:a": { action: "drop" } }, allow: [] };
  } });
  assert.equal(result.remote[0]?.failed, undefined);
  assert.equal(result.remote[0]?.actionRequired, undefined);
  const entry = readLock(lockPath(options.pluginsDir)).plugins.survivor!;
  assert.deepEqual(entry.selection, { components: ["skills"], skills: ["b"] });
  const installed = installedPluginDir(options.pluginsDir, "survivor", entry.origin);
  assert.ok(existsSync(join(installed, "skills/b/SKILL.md")));
  assert.equal(existsSync(join(installed, "agents/unselected.md")), false);
  assert.equal(existsSync(join(installed, "skills/extra/SKILL.md")), false);
});

test("full subscription follows simultaneous skill deletion and relocation without losing new skills", async t => {
  const root = mkdtempSync(join(tmpdir(), "adg-planner-full-relocation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const options = { pluginsDir: join(root, "store"), spec: "example/public-full-relocation", agents: [],
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
  plugin(remote, "survivor", "1.0.0", ["deleted", "moved", "retained"]);
  await addPlugins({ ...options, plugins: ["survivor"] });
  assert.equal(readLock(lockPath(options.pluginsDir)).plugins.survivor?.selectionKnown, true);
  plugin(remote, "survivor", "2.0.0", ["retained", "new"]);
  plugin(remote, "successor", "2.0.0", ["moved", "unrelated"]);
  const updated = await updatePlugins({ ...options,
    review: async () => { throw new Error("Unexpected full subscription review"); } });
  assert.equal(updated.remote[0]?.failed, undefined);
  assert.equal(updated.remote[0]?.actionRequired, undefined);
  const lock = readLock(lockPath(options.pluginsDir));
  assert.deepEqual(Object.keys(lock.plugins).sort(), ["successor", "survivor"]);
  assert.equal(lock.plugins.survivor?.selection, undefined);
  assert.deepEqual(lock.plugins.successor?.selection?.skills, ["moved"]);
  const survivor = installedPluginDir(options.pluginsDir, "survivor", lock.plugins.survivor!.origin);
  for (const skill of ["retained", "new"]) assert.ok(existsSync(join(survivor, "skills", skill, "SKILL.md")));
  for (const skill of ["deleted", "moved"]) assert.equal(existsSync(join(survivor, "skills", skill, "SKILL.md")), false);
  const successor = installedPluginDir(options.pluginsDir, "successor", lock.plugins.successor!.origin);
  assert.ok(existsSync(join(successor, "skills/moved/SKILL.md")));
  assert.equal(existsSync(join(successor, "skills/unrelated/SKILL.md")), false);
});

for (const peerStillProvides of [true, false]) {
  test(`missing saved peer history ${peerStillProvides ? "avoids unnecessary ownership review" : "preserves required relocation"}`, async t => {
    const root = mkdtempSync(join(tmpdir(), "adg-planner-peer-history-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const remote = join(root, "remote");
    mkdirSync(remote);
    const options = { pluginsDir: join(root, "store"), spec: "example/public-peer-history", agents: [],
      gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
    plugin(remote, "former", "1.0.0", ["shared"]);
    plugin(remote, "peer", "1.0.0", ["shared", "own"]);
    await addPlugins({ ...options, plugins: ["former"] });
    await addPlugins({ ...options, plugins: ["peer"], preserveExisting: true });
    const before = readLock(lockPath(options.pluginsDir));
    for (const source of before.sources ?? []) source.history = source.history?.filter(item => item.name !== "peer");
    assert.deepEqual(before.sources?.[0]?.history?.map(item => item.name), ["former"]);
    writeLock(lockPath(options.pluginsDir), before);
    rmSync(join(remote, "former"), { recursive: true });
    plugin(remote, "peer", "2.0.0", peerStillProvides ? ["shared", "own"] : ["own"]);
    plugin(remote, "replacement", "2.0.0", ["shared", "unrelated"]);
    const reviewed: string[] = [];
    const updated = await updatePlugins({ ...options, review: async ({ history }) => {
      assert.equal(peerStillProvides, true, "Relocation to the only remaining owner needs no review");
      assert.deepEqual(history.map(item => item.id), ["unmapped:former"]);
      reviewed.push(...history.map(item => item.id));
      return { history: { "unmapped:former": { action: "keep" } }, allow: [] };
    } });
    assert.equal(updated.remote[0]?.failed, undefined);
    assert.equal(updated.remote[0]?.actionRequired, undefined);
    const after = readLock(lockPath(options.pluginsDir));
    if (peerStillProvides) {
      assert.deepEqual(reviewed, ["unmapped:former"]);
      assert.deepEqual(Object.keys(after.plugins).sort(), ["former", "peer"]);
      assert.deepEqual(updated.remote[0]?.retained, ["former"]);
    } else {
      assert.deepEqual(reviewed, []);
      assert.deepEqual(Object.keys(after.plugins).sort(), ["peer", "replacement"]);
      assert.deepEqual(after.plugins.replacement?.selection?.skills, ["shared"]);
      const installed = installedPluginDir(options.pluginsDir, "replacement", after.plugins.replacement!.origin);
      assert.ok(existsSync(join(installed, "skills/shared/SKILL.md")));
      assert.equal(existsSync(join(installed, "skills/unrelated/SKILL.md")), false);
    }
  });
}

test("surviving partial subscription reconciles a removed skill already provided by a peer missing from history", async t => {
  const root = mkdtempSync(join(tmpdir(), "adg-planner-surviving-peer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const options = { pluginsDir: join(root, "store"), spec: "example/public-surviving-peer", agents: [],
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
  plugin(remote, "survivor", "1.0.0", ["shared", "own"]);
  plugin(remote, "peer", "1.0.0", ["shared", "unrelated"]);
  await addPlugins({ ...options, plugins: ["survivor"], only: ["skills"], skillsSubset: ["shared", "own"] });
  await addPlugins({ ...options, plugins: ["peer"], only: ["skills"], skillsSubset: ["shared"], preserveExisting: true });
  const before = readLock(lockPath(options.pluginsDir));
  for (const source of before.sources ?? []) source.history = source.history?.filter(item => item.name !== "peer");
  assert.deepEqual(before.sources?.[0]?.history?.map(item => item.name), ["survivor"]);
  writeLock(lockPath(options.pluginsDir), before);
  plugin(remote, "survivor", "2.0.0", ["own", "extra"]);
  const updated = await updatePlugins({ ...options,
    review: async () => { throw new Error("An independently selected peer requires no ownership review"); } });
  assert.equal(updated.remote[0]?.failed, undefined);
  assert.equal(updated.remote[0]?.actionRequired, undefined);
  const after = readLock(lockPath(options.pluginsDir));
  assert.deepEqual(after.plugins.survivor?.selection, { components: ["skills"], skills: ["own"] });
  assert.deepEqual(after.plugins.peer?.selection, { components: ["skills"], skills: ["shared"] });
  const survivor = installedPluginDir(options.pluginsDir, "survivor", after.plugins.survivor!.origin);
  assert.ok(existsSync(join(survivor, "skills/own/SKILL.md")));
  assert.equal(existsSync(join(survivor, "skills/shared/SKILL.md")), false);
  assert.equal(existsSync(join(survivor, "skills/extra/SKILL.md")), false);
  const peer = installedPluginDir(options.pluginsDir, "peer", after.plugins.peer!.origin);
  assert.ok(existsSync(join(peer, "skills/shared/SKILL.md")));
  assert.equal(existsSync(join(peer, "skills/unrelated/SKILL.md")), false);
});

test("a retired verified owner transfers to an already-selected unique peer without an extra retirement prompt", async t => {
  const root = mkdtempSync(join(tmpdir(), "adg-planner-unique-existing-peer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const options = { pluginsDir: join(root, "store"), spec: "example/public-unique-existing-peer", agents: [],
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
  plugin(remote, "former", "1.0.0", ["shared"]);
  plugin(remote, "peer", "1.0.0", ["shared", "extra"]);
  await addPlugins({ ...options, plugins: ["former"], only: ["skills"], skillsSubset: ["shared"] });
  await addPlugins({ ...options, plugins: ["peer"], only: ["skills"], skillsSubset: ["shared"], preserveExisting: true });
  const before = readLock(lockPath(options.pluginsDir));
  for (const source of before.sources ?? []) source.history = source.history?.filter(item => item.name !== "peer");
  assert.deepEqual(before.sources?.[0]?.history?.map(item => item.name), ["former"]);
  writeLock(lockPath(options.pluginsDir), before);
  rmSync(join(remote, "former"), { recursive: true });
  const updated = await updatePlugins({ ...options,
    review: async () => { throw new Error("Verified unique successor needs no additional retirement prompt"); } });
  assert.equal(updated.remote[0]?.failed, undefined);
  assert.equal(updated.remote[0]?.actionRequired, undefined);
  assert.deepEqual(updated.remote[0]?.deleted, ["former"]);
  const after = readLock(lockPath(options.pluginsDir));
  assert.deepEqual(Object.keys(after.plugins), ["peer"]);
  assert.deepEqual(after.plugins.peer?.selection, before.plugins.peer?.selection);
  const peer = installedPluginDir(options.pluginsDir, "peer", after.plugins.peer!.origin);
  assert.ok(existsSync(join(peer, "skills/shared/SKILL.md")));
  assert.equal(existsSync(join(peer, "skills/extra/SKILL.md")), false);
});

for (const scenario of [
  { name: "transfers an explicit request after dependency removal", dependencyRemains: false, explicit: true, ambiguous: false },
  { name: "preserves an incoming request beyond a continuing dependency", dependencyRemains: true, explicit: true, ambiguous: false },
  { name: "never promotes an unrequested historical dependency", dependencyRemains: false, explicit: false, ambiguous: false },
  { name: "reviews ambiguous owners after dependency removal", dependencyRemains: false, explicit: true, ambiguous: true },
]) {
  test(`peer hook policy ${scenario.name}`, async t => {
    const root = mkdtempSync(join(tmpdir(), "adg-planner-peer-dependency-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const remote = join(root, "remote");
    mkdirSync(remote);
    const options = { pluginsDir: join(root, "store"), spec: "example/public-peer-dependency", agents: [],
      gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
    const peerSource = (version: string, requiresSkill: boolean) => {
      plugin(remote, "peer", version, ["shared", "unrelated"]);
      const dir = join(remote, "peer");
      mkdirSync(join(dir, ".agents"));
      mkdirSync(join(dir, "hooks"));
      writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf synthetic" }] }] } }));
      writeFileSync(join(dir, ".agents/.plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "peer", version,
        description: "Synthetic dependency peer", skills: "./skills/", hooks: "./hooks/",
        ...(requiresSkill ? { selectionDependencies: { hooks: { skills: ["shared"] } } } : {}) }));
    };
    plugin(remote, "survivor", "1.0.0", ["shared", "own"]);
    peerSource("1.0.0", true);
    await addPlugins({ ...options, plugins: ["survivor"], only: ["skills"],
      skillsSubset: scenario.explicit ? ["shared", "own"] : ["own"] });
    await addPlugins({ ...options, plugins: ["peer"], only: ["hooks"], preserveExisting: true });
    const before = readLock(lockPath(options.pluginsDir));
    assert.deepEqual(before.plugins.peer?.selection, { components: ["hooks"] });
    for (const source of before.sources ?? []) source.history = source.history?.filter(item => item.name !== "peer");
    writeLock(lockPath(options.pluginsDir), before);
    plugin(remote, "survivor", "2.0.0", ["own", "extra"]);
    peerSource("2.0.0", scenario.dependencyRemains);
    if (scenario.ambiguous) plugin(remote, "alternative", "2.0.0", ["shared"]);
    const prompts: string[] = [];
    const updated = await updatePlugins({ ...options, review: async ({ history, executable }) => {
      assert.equal(scenario.ambiguous, true);
      assert.deepEqual(history.map(item => item.id), ["ownership:survivor:shared"]);
      assert.deepEqual(history[0]?.skills, ["alternative:shared", "peer:shared"]);
      assert.deepEqual(executable, []);
      prompts.push(...history.map(item => item.id));
      return { history: { "ownership:survivor:shared": { action: "select", skills: ["peer:shared"] } }, allow: [] };
    } });
    assert.equal(updated.remote[0]?.failed, undefined);
    assert.equal(updated.remote[0]?.actionRequired, undefined);
    assert.deepEqual(prompts, scenario.ambiguous ? ["ownership:survivor:shared"] : []);
    const after = readLock(lockPath(options.pluginsDir));
    const transferred = scenario.explicit;
    assert.deepEqual(after.plugins.survivor?.selection, { components: ["skills"], skills: ["own"] });
    assert.deepEqual(after.plugins.peer?.selection, transferred
      ? { components: ["skills", "hooks"], skills: ["shared"] } : { components: ["hooks"] });
    const peer = installedPluginDir(options.pluginsDir, "peer", after.plugins.peer!.origin);
    assert.equal(existsSync(join(peer, "skills/shared/SKILL.md")), scenario.explicit || scenario.dependencyRemains);
    assert.ok(existsSync(join(peer, "hooks/hooks.json")));
    assert.equal(existsSync(join(peer, "skills/unrelated/SKILL.md")), false);
    const survivor = installedPluginDir(options.pluginsDir, "survivor", after.plugins.survivor!.origin);
    assert.equal(existsSync(join(survivor, "skills/extra/SKILL.md")), false);
    assert.equal(after.plugins.alternative, undefined);
    if (scenario.dependencyRemains) {
      peerSource("3.0.0", false);
      const next = await updatePlugins({ ...options,
        review: async () => { throw new Error("An earlier explicit skill request must survive dependency removal"); } });
      assert.equal(next.remote[0]?.failed, undefined);
      assert.equal(next.remote[0]?.actionRequired, undefined);
      const final = readLock(lockPath(options.pluginsDir));
      const finalPeer = installedPluginDir(options.pluginsDir, "peer", final.plugins.peer!.origin);
      assert.ok(existsSync(join(finalPeer, "skills/shared/SKILL.md")));
    }
  });
}

test("incoming skills preserve an all-MCP request across prior and subsequent executable denials", async t => {
  const root = mkdtempSync(join(tmpdir(), "adg-planner-requested-peer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const options = { pluginsDir: join(root, "store"), spec: "example/public-requested-peer", agents: [],
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
  const peerSource = (version: string, servers: string[], requiresSkill: boolean) => {
    plugin(remote, "peer", version, ["shared", "unrelated"]);
    const dir = join(remote, "peer");
    mkdirSync(join(dir, ".agents"));
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf synthetic" }] }] } }));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(servers.map(name => [name, { command: name }])) }));
    writeFileSync(join(dir, ".agents/.plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "peer", version,
      description: "Synthetic requested policy peer", skills: "./skills/", hooks: "./hooks/", mcpServers: "./.mcp.json",
      ...(requiresSkill ? { selectionDependencies: { hooks: { skills: ["shared"] } } } : {}) }));
  };
  plugin(remote, "survivor", "1.0.0", ["shared", "own"]);
  peerSource("1.0.0", ["base"], true);
  await addPlugins({ ...options, plugins: ["survivor"], only: ["skills"], skillsSubset: ["shared", "own"] });
  await addPlugins({ ...options, plugins: ["peer"], only: ["hooks", "mcp"], targets: ["codex"], preserveExisting: true });
  const requested = () => readLock(lockPath(options.pluginsDir)).sources?.[0]?.desiredSelections?.peer;
  const services = () => {
    const lock = readLock(lockPath(options.pluginsDir));
    const peer = installedPluginDir(options.pluginsDir, "peer", lock.plugins.peer!.origin);
    return Object.keys(JSON.parse(readFileSync(join(peer, ".mcp.json"), "utf8")).mcpServers).sort();
  };
  peerSource("2.0.0", ["base", "optional"], true);
  const declined = await updatePlugins({ ...options, review: async ({ history, executable }) => {
    assert.deepEqual(history, []);
    assert.equal(executable.length, 1);
    assert.match(executable[0]!.label, /optional/);
    return { history: {}, allow: [] };
  } });
  assert.equal(declined.remote[0]?.failed, undefined);
  assert.deepEqual(services(), ["base"]);
  assert.deepEqual(requested(), { components: ["mcp", "hooks"] });

  plugin(remote, "survivor", "2.0.0", ["own"]);
  peerSource("3.0.0", ["base", "optional", "later"], false);
  const laterPrompts: string[] = [];
  const migrated = await updatePlugins({ ...options, review: async ({ history, executable }) => {
    assert.deepEqual(history, []);
    laterPrompts.push(...executable.map(item => item.label));
    return { history: {}, allow: [] };
  } });
  assert.equal(migrated.remote[0]?.failed, undefined);
  assert.equal(migrated.remote[0]?.actionRequired, undefined);
  assert.equal(laterPrompts.length, 1);
  assert.match(laterPrompts[0]!, /later/);
  assert.deepEqual(services(), ["base"]);
  assert.deepEqual(requested(), { components: ["skills", "mcp", "hooks"], skills: ["shared"] });
  const lock = readLock(lockPath(options.pluginsDir));
  assert.deepEqual(lock.plugins.peer?.selection, { components: ["skills", "mcp", "hooks"], skills: ["shared"], mcp: ["base"] });
  assert.deepEqual(lock.plugins.survivor?.selection?.skills, ["own"]);
  const peer = installedPluginDir(options.pluginsDir, "peer", lock.plugins.peer!.origin);
  assert.ok(existsSync(join(peer, "skills/shared/SKILL.md")));
  assert.equal(existsSync(join(peer, "skills/unrelated/SKILL.md")), false);

  peerSource("4.0.0", ["base", "optional", "later", "future"], false);
  const futurePrompts: string[] = [];
  const repeated = await updatePlugins({ ...options, review: async ({ executable }) => {
    futurePrompts.push(...executable.map(item => item.label));
    return { history: {}, allow: [] };
  } });
  assert.equal(repeated.remote[0]?.failed, undefined);
  assert.equal(futurePrompts.length, 1);
  assert.match(futurePrompts[0]!, /future/);
  assert.deepEqual(services(), ["base"]);
  assert.deepEqual(requested(), { components: ["skills", "mcp", "hooks"], skills: ["shared"] });
});

test("declining a newly executable hook does not remove a relocated explicit skill request", async t => {
  const root = mkdtempSync(join(tmpdir(), "adg-planner-declined-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  const options = { pluginsDir: join(root, "store"), spec: "example/public-declined-hook", agents: [], targets: ["codex" as const],
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); } };
  const peerSource = (version: string, executable: boolean) => {
    plugin(remote, "peer", version, ["shared", "unrelated"]);
    const dir = join(remote, "peer");
    mkdirSync(join(dir, ".agents"));
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: executable
      ? { SessionStart: [{ hooks: [{ type: "command", command: "printf synthetic" }] }] } : {} }));
    writeFileSync(join(dir, ".agents/.plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "peer", version,
      description: "Synthetic newly executable hook", skills: "./skills/", hooks: "./hooks/",
      selectionDependencies: { hooks: { skills: ["shared"] } } }));
  };
  plugin(remote, "survivor", "1.0.0", ["shared", "own"]);
  peerSource("1.0.0", false);
  await addPlugins({ ...options, plugins: ["survivor"], only: ["skills"], skillsSubset: ["shared", "own"] });
  await addPlugins({ ...options, plugins: ["peer"], only: ["hooks"], preserveExisting: true });
  plugin(remote, "survivor", "2.0.0", ["own"]);
  peerSource("2.0.0", true);
  let reviewed = 0;
  const updated = await updatePlugins({ ...options, review: async ({ history, executable }) => {
    assert.deepEqual(history, []);
    assert.equal(executable.length, 1);
    assert.match(executable[0]!.label, /peer.*hook/);
    reviewed++;
    return { history: {}, allow: [] };
  } });
  assert.equal(updated.remote[0]?.failed, undefined);
  assert.equal(updated.remote[0]?.actionRequired, undefined);
  assert.equal(reviewed, 1);
  const lock = readLock(lockPath(options.pluginsDir));
  assert.deepEqual(lock.plugins.peer?.selection, { components: ["skills"], skills: ["shared"] });
  assert.deepEqual(lock.sources?.[0]?.desiredSelections?.peer, { components: ["skills", "hooks"], skills: ["shared"] });
  const peer = installedPluginDir(options.pluginsDir, "peer", lock.plugins.peer!.origin);
  assert.ok(existsSync(join(peer, "skills/shared/SKILL.md")));
  assert.equal(existsSync(join(peer, "skills/unrelated/SKILL.md")), false);
  assert.equal(existsSync(join(peer, "hooks/hooks.json")), false);
});
