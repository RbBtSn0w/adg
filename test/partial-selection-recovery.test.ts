import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPlugins } from "../src/commands/install.ts";
import { installPlugin } from "../src/commands/install/install-one.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import { installedHistory } from "../src/source-history.ts";
import { readLock, writeLock } from "../src/lock.ts";
import { installedPluginDir, lockPath, pluginSourceCacheDir } from "../src/paths.ts";

function plugin(root: string, name: string, skills: string[], version = "1.0.0") {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin/plugin.json"), JSON.stringify({ name, version, description: name }));
  mkdirSync(join(dir, ".agents"));
  writeFileSync(join(dir, ".agents/.plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name, version, description: name, skills: "./skills/" }));
  for (const skill of skills) {
    mkdirSync(join(dir, "skills", skill), { recursive: true });
    writeFileSync(join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill}\n---\nReusable skill.\n`);
  }
  return dir;
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "adg-partial-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  mkdirSync(remote);
  return { root, remote, pluginsDir: join(root, "store"), spec: "example/ordinary",
    gitRunner: (args: string[]) => { if (args[0] === "clone") cpSync(remote, args.at(-1)!, { recursive: true }); }, agents: [] };
}

async function partialLegacy(t: TestContext) {
  const s = setup(t);
  plugin(s.remote, "survivor", ["known", "one", "two"]);
  await addPlugins({ ...s, plugins: ["survivor"] });
  const before = readLock(lockPath(s.pluginsDir));
  const prior = installedHistory(s.pluginsDir, before, s.spec)[0]!;
  const current = plugin(s.remote, "survivor", ["known"], "2.0.0");
  installPlugin({ source: current, pluginsDir: s.pluginsDir, origin: before.plugins.survivor!.origin });
  plugin(s.remote, "new-owner", ["one", "two", "extra"], "2.0.0");
  const lock = readLock(lockPath(s.pluginsDir));
  lock.sources![0]!.history = [{ ...prior, selectionKnown: false, evidence: "catalog" }];
  writeLock(lockPath(s.pluginsDir), lock);
  return s;
}

test("partial choices survive a split under whole-source policy and --all", async t => {
  for (const all of [false, true]) {
    const s = setup(t);
    plugin(s.remote, "former", ["a", "b", "c", "d"]);
    await addPlugins({ ...s, all: true, confirmFull: () => false,
      selectComponents: () => ({ components: ["skills"], skills: ["a", "c"] }) });
    rmSync(join(s.remote, "former"), { recursive: true });
    plugin(s.remote, "core", ["a", "b", "e"]);
    plugin(s.remote, "tools", ["c", "d", "f"]);
    const result = await updatePlugins({ ...s, all });
    assert.equal(result.remote[0]?.failed, undefined);
    assert.equal(result.remote[0]?.actionRequired, undefined);
    const lock = readLock(lockPath(s.pluginsDir));
    assert.deepEqual(lock.plugins.core?.selection?.skills, ["a"]);
    assert.deepEqual(lock.plugins.tools?.selection?.skills, ["c"]);
    for (const [name, wanted] of [["core", "a"], ["tools", "c"]]) {
      const entry = lock.plugins[name!]!;
      const dir = installedPluginDir(s.pluginsDir, name!, entry.origin);
      assert.ok(existsSync(join(dir, "skills", wanted!, "SKILL.md")));
      assert.equal(existsSync(join(dir, "skills", name === "core" ? "b" : "d", "SKILL.md")), false);
    }
  }
});

test("unknown historical selection is deferred without blocking a current update", async t => {
  const s = await partialLegacy(t);
  plugin(s.remote, "survivor", ["known", "fresh"], "3.0.0");
  const result = await updatePlugins(s);
  assert.equal(result.remote[0]?.failed, undefined);
  assert.equal(result.remote[0]?.actionRequired, undefined);
  assert.deepEqual(result.remote[0]?.deferredRecovery, ["new-owner:one", "new-owner:two"]);
  const lock = readLock(lockPath(s.pluginsDir));
  assert.equal(lock.plugins["new-owner"], undefined);
  assert.equal(lock.plugins.survivor?.version, "3.0.0");
  assert.ok(existsSync(join(installedPluginDir(s.pluginsDir, "survivor", lock.plugins.survivor!.origin), "skills/fresh/SKILL.md")));
  assert.equal(lock.sources![0]!.excluded.length, 0);
  assert.equal(lock.sources![0]!.deferredRecovery?.length, 1);
});

test("deferred history survives repeat and can be reconsidered with --repair", async t => {
  const s = await partialLegacy(t);
  await updatePlugins({ ...s, review: async ({ history }) => ({ history: Object.fromEntries(history.map(item => [item.id, { action: "keep" as const }])), allow: [] }) });
  const before = readFileSync(lockPath(s.pluginsDir), "utf8");
  const repeated = await updatePlugins({ ...s, review: async () => { throw new Error("Unchanged deferral must not prompt"); } });
  assert.deepEqual(repeated.remote[0]?.deferredRecovery, ["new-owner:one", "new-owner:two"]);
  assert.equal(readFileSync(lockPath(s.pluginsDir), "utf8"), before);
  const repaired = await updatePlugins({ ...s, repair: true, review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, { action: "select" as const, skills: ["new-owner:two"] }])), allow: [],
  }) });
  assert.equal(repaired.remote[0]?.failed, undefined);
  assert.deepEqual(repaired.remote[0]?.restored, ["new-owner:two"]);
  const lock = readLock(lockPath(s.pluginsDir));
  assert.deepEqual(lock.plugins["new-owner"]?.selection?.skills, ["two"]);
  assert.equal(lock.sources![0]!.deferredRecovery?.length ?? 0, 0);
});

test("whole-source policy cannot implicitly restore unknown historical selections", async t => {
  const s = await partialLegacy(t);
  const lock = readLock(lockPath(s.pluginsDir));
  lock.sources![0]!.mode = "all";
  writeLock(lockPath(s.pluginsDir), lock);
  const result = await updatePlugins(s);
  assert.deepEqual(result.remote[0]?.deferredRecovery, ["new-owner:one", "new-owner:two"]);
  const entry = readLock(lockPath(s.pluginsDir)).plugins["new-owner"];
  if (entry) {
    const dir = installedPluginDir(s.pluginsDir, "new-owner", entry.origin);
    assert.equal(existsSync(join(dir, "skills/one/SKILL.md")), false);
    assert.equal(existsSync(join(dir, "skills/two/SKILL.md")), false);
    assert.equal(existsSync(join(dir, "skills/extra/SKILL.md")), false);
  }
});

test("unknown cache-only selection retains its old payload until explicit recovery", async t => {
  const s = setup(t);
  plugin(s.remote, "former", ["a", "b"]);
  await addPlugins({ ...s, plugins: ["former"] });
  const lock = readLock(lockPath(s.pluginsDir));
  const entry = lock.plugins.former!;
  delete entry.selectionKnown;
  delete lock.sources![0]!.history;
  const dir = installedPluginDir(s.pluginsDir, "former", entry.origin);
  rmSync(join(dir, "skills/a/SKILL.md"));
  writeLock(lockPath(s.pluginsDir), lock);
  const before = readFileSync(join(dir, "skills/b/SKILL.md"), "utf8");
  const result = await updatePlugins(s);
  assert.equal(result.remote[0]?.failed, undefined);
  assert.deepEqual(result.remote[0]?.deferredRecovery, ["former:a", "former:b"]);
  assert.equal(readFileSync(join(dir, "skills/b/SKILL.md"), "utf8"), before);
  assert.equal(readLock(lockPath(s.pluginsDir)).plugins.former?.installedHash, entry.installedHash);
  const selected = await updatePlugins({ ...s, repair: true, review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, { action: "select" as const, skills: ["former:b"] }])), allow: [],
  }) });
  assert.equal(selected.remote[0]?.failed, undefined);
  const recovered = readLock(lockPath(s.pluginsDir)).plugins.former!;
  assert.deepEqual(recovered.selection?.skills, ["b"]);
  assert.equal(existsSync(join(dir, "skills/a/SKILL.md")), false);
});

test("unverified legacy selection cannot expand when both installation and cache are damaged", async t => {
  const s = setup(t);
  plugin(s.remote, "former", ["a", "b"]);
  await addPlugins({ ...s, plugins: ["former"] });
  const lock = readLock(lockPath(s.pluginsDir));
  const entry = lock.plugins.former!;
  delete entry.selectionKnown;
  delete lock.sources![0]!.history;
  writeFileSync(join(installedPluginDir(s.pluginsDir, "former", entry.origin), "skills/a/SKILL.md"), "Changed locally");
  entry.sourceHash = "sha256-" + "0".repeat(64);
  writeLock(lockPath(s.pluginsDir), lock);
  plugin(s.remote, "former", ["a", "b", "new"]);
  const before = readFileSync(lockPath(s.pluginsDir), "utf8");
  const result = await updatePlugins(s);
  assert.match(result.remote[0]?.actionRequired?.join(" ") ?? "", /verify.*selection/i);
  assert.equal(readFileSync(lockPath(s.pluginsDir), "utf8"), before);
});

test("deferred candidates remain selectable after their original owner retires", async t => {
  const s = await partialLegacy(t);
  await updatePlugins(s);
  rmSync(join(s.remote, "survivor"), { recursive: true });
  plugin(s.remote, "known-owner", ["known"], "3.0.0");
  const moved = await updatePlugins({ ...s, review: async () => { throw new Error("Unchanged deferral must stay quiet"); } });
  assert.equal(moved.remote[0]?.failed, undefined);
  assert.deepEqual(moved.remote[0]?.deleted, ["survivor"]);
  assert.deepEqual(moved.remote[0]?.deferredRecovery, ["new-owner:one", "new-owner:two"]);
  const restored = await updatePlugins({ ...s, repair: true, review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, { action: "restore" as const }])), allow: [],
  }) });
  assert.equal(restored.remote[0]?.failed, undefined);
  assert.deepEqual(restored.remote[0]?.restored, ["new-owner:one", "new-owner:two"]);
  assert.deepEqual(readLock(lockPath(s.pluginsDir)).plugins["new-owner"]?.selection?.skills, ["one", "two"]);
});

test("unchanged-revision fast path reports deferred recovery and --repair reopens it", async t => {
  const s = await partialLegacy(t);
  const revisionResolver = () => "b".repeat(40);
  await updatePlugins({ ...s, revisionResolver });
  const before = readFileSync(lockPath(s.pluginsDir), "utf8");
  const repeated = await updatePlugins({ ...s, revisionResolver, gitRunner: () => { throw new Error("Unchanged source must not fetch"); } });
  assert.deepEqual(repeated.remote[0]?.deferredRecovery, ["new-owner:one", "new-owner:two"]);
  assert.equal(readFileSync(lockPath(s.pluginsDir), "utf8"), before);
  const selected = await updatePlugins({ ...s, revisionResolver, repair: true, review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, { action: "select" as const, skills: ["new-owner:one"] }])), allow: [],
  }) });
  assert.equal(selected.remote[0]?.failed, undefined);
  assert.deepEqual(selected.remote[0]?.restored, ["new-owner:one"]);
});

test("an unknown cache-only rename keeps the old payload until an explicit choice", async t => {
  const s = setup(t);
  plugin(s.remote, "former", ["a", "b"]);
  await addPlugins({ ...s, plugins: ["former"] });
  const lock = readLock(lockPath(s.pluginsDir));
  const old = lock.plugins.former!;
  delete old.selectionKnown;
  delete lock.sources![0]!.history;
  const dir = installedPluginDir(s.pluginsDir, "former", old.origin);
  rmSync(join(dir, "skills/a/SKILL.md"));
  writeLock(lockPath(s.pluginsDir), lock);
  rmSync(join(s.remote, "former"), { recursive: true });
  plugin(s.remote, "current", ["a", "b", "extra"]);
  mkdirSync(join(s.remote, ".claude-plugin"));
  writeFileSync(join(s.remote, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "ordinary", plugins: [{ name: "current", source: "./current" }], renames: { former: "current" } }));
  const result = await updatePlugins(s);
  assert.equal(result.remote[0]?.failed, undefined);
  assert.deepEqual(result.remote[0]?.deleted, []);
  assert.ok(result.remote[0]?.deferredRecovery?.includes("current:a"));
  assert.ok(readLock(lockPath(s.pluginsDir)).plugins.former);
  assert.equal(existsSync(join(dir, "skills/b/SKILL.md")), true);
  assert.equal(readLock(lockPath(s.pluginsDir)).plugins.current, undefined);
});

test("a selected source with deferred candidates remains reachable after its last owner retires", async t => {
  const s = await partialLegacy(t);
  await updatePlugins(s);
  rmSync(join(s.remote, "survivor"), { recursive: true });
  mkdirSync(join(s.remote, ".claude-plugin"));
  writeFileSync(join(s.remote, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "ordinary", plugins: [{ name: "new-owner", source: "./new-owner" }], renames: { survivor: null } }));
  await updatePlugins(s);
  assert.deepEqual(Object.keys(readLock(lockPath(s.pluginsDir)).plugins), []);
  const result = await updatePlugins({ ...s, source: s.spec, repair: true, review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, { action: "select" as const, skills: ["new-owner:one"] }])), allow: [],
  }) });
  assert.equal(result.remote[0]?.failed, undefined);
  assert.deepEqual(readLock(lockPath(s.pluginsDir)).plugins["new-owner"]?.selection?.skills, ["one"]);
});

test("a removed component dependency does not become a directly selected relocated skill", async t => {
  const s = setup(t);
  const former = plugin(s.remote, "former", ["bootstrap"]);
  const addHooks = (dir: string, dependency: boolean) => {
    const file = join(dir, ".agents/.plugin.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.hooks = "./hooks/";
    if (dependency) manifest.selectionDependencies = { hooks: { skills: ["bootstrap"] } };
    writeFileSync(file, JSON.stringify(manifest));
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: {} }));
  };
  addHooks(former, true);
  await addPlugins({ ...s, plugins: ["former"], only: ["hooks"] });
  plugin(s.remote, "former", [], "2.0.0");
  addHooks(former, false);
  plugin(s.remote, "new-owner", ["bootstrap", "extra"], "2.0.0");
  const result = await updatePlugins(s);
  assert.equal(result.remote[0]?.failed, undefined);
  const lock = readLock(lockPath(s.pluginsDir));
  assert.equal(lock.plugins["new-owner"], undefined);
  assert.deepEqual(lock.plugins.former?.selection, { components: ["hooks"] });
  assert.equal(existsSync(join(installedPluginDir(s.pluginsDir, "former", lock.plugins.former!.origin), "skills/bootstrap/SKILL.md")), false);
});

test("ambiguous unknown candidates defer quietly and allow a later explicit owner choice", async t => {
  const s = await partialLegacy(t);
  plugin(s.remote, "alternate", ["one"], "2.0.0");
  const deferred = await updatePlugins(s);
  assert.equal(deferred.remote[0]?.actionRequired, undefined);
  assert.deepEqual(deferred.remote[0]?.deferredRecovery, ["alternate:one", "new-owner:one", "new-owner:two"]);
  const repeated = await updatePlugins({ ...s, review: async () => { throw new Error("Unchanged candidates must stay deferred"); } });
  assert.equal(repeated.remote[0]?.failed, undefined);
  const chosen = await updatePlugins({ ...s, repair: true, review: async ({ history }) => ({
    history: Object.fromEntries(history.map(item => [item.id, item.skills.includes("alternate:one")
      ? { action: "select" as const, skills: ["alternate:one"] } : { action: "keep" as const }])), allow: [],
  }) });
  assert.equal(chosen.remote[0]?.failed, undefined);
  assert.deepEqual(chosen.remote[0]?.restored, ["alternate:one"]);
  assert.deepEqual(readLock(lockPath(s.pluginsDir)).plugins.alternate?.selection?.skills, ["one"]);
});

test("ordinary update repairs a malformed source cache using a verified installed selection", async t => {
  const s = setup(t);
  plugin(s.remote, "former", ["a", "b", "c"]);
  await addPlugins({ ...s, plugins: ["former"], skillsSubset: ["a", "c"] });
  writeFileSync(join(pluginSourceCacheDir(s.pluginsDir, "former"), ".agents/.plugin.json"), "{truncated");
  plugin(s.remote, "former", ["a", "b", "c", "extra"], "2.0.0");
  const updated = await updatePlugins(s);
  assert.equal(updated.remote[0]?.failed, undefined);
  assert.equal(updated.remote[0]?.actionRequired, undefined);
  assert.deepEqual(readLock(lockPath(s.pluginsDir)).plugins.former?.selection?.skills, ["a", "c"]);
  assert.equal(JSON.parse(readFileSync(join(pluginSourceCacheDir(s.pluginsDir, "former"), ".agents/.plugin.json"), "utf8")).version, "2.0.0");
});

test("each ambiguous skill in a deferred group accepts an independent owner choice", async t => {
  const s = await partialLegacy(t);
  await updatePlugins(s);
  plugin(s.remote, "alternate", ["one", "two"]);
  let questions = 0;
  const updated = await updatePlugins({ ...s, repair: true, review: async ({ history }) => {
    assert.equal(new Set(history.map(item => item.id)).size, history.length);
    questions += history.length;
    assert.ok(questions <= 2, "Each ownership decision is asked once");
    return { history: Object.fromEntries(history.map(item => [item.id, { action: "select" as const,
      skills: [item.skills.includes("alternate:one") ? "alternate:one" : "new-owner:two"] }])), allow: [] };
  } });
  assert.equal(updated.remote[0]?.failed, undefined);
  assert.deepEqual(updated.remote[0]?.restored?.sort(), ["alternate:one", "new-owner:two"]);
  const lock = readLock(lockPath(s.pluginsDir));
  assert.deepEqual(lock.plugins.alternate?.selection?.skills, ["one"]);
  assert.deepEqual(lock.plugins["new-owner"]?.selection?.skills, ["two"]);
});

for (const component of ["hooks", "mcp"] as const) for (const changed of [false, true]) {
  test(`malformed cache preserves existing ${component} when its new content is ${changed ? "declined" : "unchanged"}`, async t => {
    const s = setup(t);
    const define = (version: string, revision: string) => {
      const dir = plugin(s.remote, "former", ["unused"], version);
      const file = join(dir, ".agents/.plugin.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (component === "hooks") {
        manifest.hooks = "./hooks/";
        mkdirSync(join(dir, "hooks"));
        writeFileSync(join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${revision}` }] }] } }));
      } else {
        manifest.mcpServers = "./.mcp.json";
        writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { service: { type: "http", url: `https://example.test/${revision}` } } }));
      }
      writeFileSync(file, JSON.stringify(manifest));
    };
    define("1.0.0", "previous");
    await addPlugins({ ...s, plugins: ["former"], only: [component], targets: ["claude"] });
    const before = readFileSync(lockPath(s.pluginsDir), "utf8");
    writeFileSync(join(pluginSourceCacheDir(s.pluginsDir, "former"), ".agents/.plugin.json"), "{truncated");
    define("2.0.0", changed ? "changed" : "previous");
    let requests = 0;
    const result = await updatePlugins({ ...s, targets: ["claude"], review: async ({ executable }) => {
      requests += executable.length;
      return { history: {}, allow: [] };
    } });
    assert.equal(result.remote[0]?.failed, undefined);
    if (changed) {
      assert.ok(requests > 0);
      assert.match(result.remote[0]?.actionRequired?.join(" ") ?? "", /existing installation was kept/i);
      assert.equal(readFileSync(lockPath(s.pluginsDir), "utf8"), before);
    } else {
      assert.equal(requests, 0);
      assert.equal(result.remote[0]?.actionRequired, undefined);
      assert.deepEqual(readLock(lockPath(s.pluginsDir)).plugins.former?.selection?.components, [component]);
    }
  });
}
