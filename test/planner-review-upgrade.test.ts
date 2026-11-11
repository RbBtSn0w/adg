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
