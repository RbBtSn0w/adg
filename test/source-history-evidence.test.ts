import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin, contentHash } from "../src/commands/install/install-one.ts";
import { installedHistory, recoverLegacyHistory } from "../src/source-history.ts";
import { emptyLock, readLock, writeLock } from "../src/lock.ts";
import { readManifest } from "../src/manifest.ts";
import { pluginContents } from "../src/components.ts";
import { lockPath, pluginSourceCacheDir } from "../src/paths.ts";
import type { PluginSelection, SourceHistoryEntry } from "../src/types.ts";
import { updateLock } from "../src/commands/update.ts";
import { enablePlugins, disablePlugins } from "../src/commands/state.ts";
import { rematerializeInstalled } from "../src/commands/projection.ts";
import { listPlugins } from "../src/commands/list.ts";

const source = "example/public-history";

for (const operation of ["update", "projection", "enable"] as const) for (const legacy of [false, true]) {
  test(`internal ${operation} preserves unknown requested provenance${legacy ? " with a missing legacy selection" : ""}`, t => {
    const f = fixture(t);
    f.entry.selectionKnown = false;
    if (legacy) { delete f.entry.selection; delete f.entry.selectionKnown; }
    writeLock(lockPath(f.store), f.lock);
    if (operation === "update") updateLock(f.store);
    else if (operation === "projection") rematerializeInstalled(f.store, listPlugins(f.store));
    else {
      disablePlugins({ pluginsDir: f.store, names: ["demo"], scope: "project", agents: [] });
      enablePlugins({ pluginsDir: f.store, names: ["demo"], scope: "project", agents: [] });
    }
    assert.equal(readLock(lockPath(f.store)).plugins.demo?.selectionKnown, false);
    assert.deepEqual(readLock(lockPath(f.store)).plugins.demo?.selection?.skills, ["a", "c"]);
    assert.equal(existsSync(join(f.built.installedTo, "skills/b/SKILL.md")), false);
  });
}
function writePlugin(dir: string, name = "demo", skills = ["a", "b", "c"], version = "1.0.0"): void {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name, version, description: "Synthetic history evidence", skills: "./skills/" }));
  for (const skill of skills) {
    mkdirSync(join(dir, "skills", skill), { recursive: true });
    writeFileSync(join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Synthetic\n---\n${skill}\n`);
  }
}
function fixture(t: TestContext, selection: PluginSelection | null = { components: ["skills"], skills: ["a", "c"] }) {
  const root = mkdtempSync(join(tmpdir(), "adg-history-evidence-"));
  const previous = process.env.ADG_CACHE_HOME; process.env.ADG_CACHE_HOME = join(root, "cache");
  t.after(() => { if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous; rmSync(root, { recursive: true, force: true }); });
  const upstream = join(root, "source"); writePlugin(upstream);
  const store = join(root, "store");
  const built = installPlugin({ source: upstream, pluginsDir: store, origin: { type: "github", repo: source, path: "." }, targets: [], selection: selection ?? undefined });
  const lock = readLock(lockPath(store));
  return { root, upstream, store, built, lock, entry: lock.plugins.demo!, cache: pluginSourceCacheDir(store, "demo") };
}

test("unknown legacy request uses verified installed a,c rather than its full source cache", t => {
  const f = fixture(t); delete f.entry.selection; delete f.entry.selectionKnown;
  const history = installedHistory(f.store, f.lock, source);
  assert.deepEqual(history[0]?.contents.skills, ["a", "b", "c"]);
  assert.deepEqual(history[0]?.effectiveSelection?.skills, ["a", "c"]);
  assert.equal(history[0]?.selectionKnown, false); assert.equal(history[0]?.evidence, "installed"); assert.equal(history[0]?.selection, undefined);
});

for (const damage of ["missing", "modified"] as const) {
  test(`${damage} installed bytes and unknown request leave only catalog evidence`, t => {
    const f = fixture(t); delete f.entry.selection; delete f.entry.selectionKnown;
    if (damage === "missing") rmSync(f.built.installedTo, { recursive: true });
    else writeFileSync(join(f.built.installedTo, "skills", "a", "SKILL.md"), "tampered");
    const history = installedHistory(f.store, f.lock, source);
    assert.deepEqual(history[0]?.contents.skills, ["a", "b", "c"]); assert.deepEqual(history[0]?.effectiveSelection, { components: [] });
    assert.equal(history[0]?.selectionKnown, false); assert.equal(history[0]?.evidence, "catalog");
  });
  test(`${damage} installed bytes can be repaired from known partial policy and verified cache`, t => {
    const f = fixture(t); f.entry.selectionKnown = true;
    if (damage === "missing") rmSync(f.built.installedTo, { recursive: true });
    else writeFileSync(join(f.built.installedTo, "skills", "a", "SKILL.md"), "tampered");
    const history = installedHistory(f.store, f.lock, source);
    assert.deepEqual(history[0]?.effectiveSelection?.skills, ["a", "c"]); assert.equal(history[0]?.selectionKnown, true); assert.equal(history[0]?.evidence, "selection");
  });
}

test("malformed source cache does not hide independently verified installed evidence", t => {
  const f = fixture(t); delete f.entry.selection; delete f.entry.selectionKnown;
  writeFileSync(join(f.cache, ".agents", ".plugin.json"), "malformed");
  const history = installedHistory(f.store, f.lock, source);
  assert.equal(history.length, 1); assert.deepEqual(history[0]?.contents.skills, ["a", "c"]); assert.deepEqual(history[0]?.effectiveSelection?.skills, ["a", "c"]); assert.equal(history[0]?.evidence, "installed");
});

test("tampered installed payload is not accepted when source cache is unavailable", t => {
  const f = fixture(t); delete f.entry.selection; delete f.entry.selectionKnown; rmSync(f.cache, { recursive: true });
  writeFileSync(join(f.built.installedTo, "skills", "c", "SKILL.md"), "tampered");
  assert.deepEqual(installedHistory(f.store, f.lock, source), []);
});

test("explicit new full install is distinguished from a legacy missing full-selection field", t => {
  const f = fixture(t, null);
  assert.equal(f.entry.selectionKnown, true); assert.equal(f.entry.selection, undefined);
  let history = installedHistory(f.store, f.lock, source);
  assert.equal(history[0]?.selectionKnown, true); assert.equal(history[0]?.evidence, "selection"); assert.equal(history[0]?.effectiveSelection, undefined);
  delete f.entry.selectionKnown;
  history = installedHistory(f.store, f.lock, source);
  assert.equal(history[0]?.selectionKnown, false); assert.equal(history[0]?.evidence, "installed"); assert.deepEqual(history[0]?.effectiveSelection?.skills, ["a", "b", "c"]);
});

test("legacy explicit partial selection remains known unless explicitly marked uncertain", t => {
  const f = fixture(t); delete f.entry.selectionKnown;
  assert.equal(installedHistory(f.store, f.lock, source)[0]?.selectionKnown, true);
  f.entry.selectionKnown = false;
  const history = installedHistory(f.store, f.lock, source);
  assert.equal(history[0]?.selectionKnown, false); assert.equal(history[0]?.selection, undefined); assert.deepEqual(history[0]?.effectiveSelection?.skills, ["a", "c"]);
});

test("source-cache-only legacy full request never implies every available skill was selected", t => {
  const f = fixture(t, null); delete f.entry.selectionKnown; rmSync(f.built.installedTo, { recursive: true });
  const history = installedHistory(f.store, f.lock, source);
  assert.equal(history[0]?.selectionKnown, false); assert.equal(history[0]?.evidence, "catalog"); assert.deepEqual(history[0]?.effectiveSelection, { components: [] });
});

test("recovered old release is catalog evidence and cannot turn a current full receipt into an old full choice", async t => {
  const f = fixture(t);
  const oldRelease = join(f.root, "old-release"); const retired = join(oldRelease, "retired"); const olderPeer = join(oldRelease, "demo");
  writePlugin(retired, "retired", ["anchor"], "1.0.0"); writePlugin(olderPeer, "demo", ["a", "b", "c", "old-extra"], "1.0.0");
  const anchor: SourceHistoryEntry = { name: "retired", version: "1.0.0", origin: { type: "github", repo: source, path: "retired" }, sourceHash: contentHash(retired, readManifest(retired)), contents: pluginContents(retired, readManifest(retired)), selectionKnown: true, evidence: "selection" };
  const peer: SourceHistoryEntry = { name: "demo", version: "2.0.0", origin: { type: "github", repo: source, path: "demo" }, sourceHash: "sha256-newer", contents: { ...anchor.contents, skills: ["a", "c"] }, selectionKnown: true, evidence: "selection" };
  const lock = emptyLock();
  for (const entry of [anchor, peer]) lock.plugins[entry.name] = { origin: entry.origin, version: entry.version, sourceHash: entry.sourceHash!, installedHash: "sha256-installed", installedAt: "now", updatedAt: "now", resolvedRevision: "a".repeat(40) };
  const recovered = await recoverLegacyHistory({ source, lock, installed: [anchor, peer], currentNames: new Set(["demo"]), runner: args => { if (args[0] === "clone") cpSync(oldRelease, args.at(-1)!, { recursive: true }); } });
  const rows = recovered as Array<SourceHistoryEntry & { uncertain?: boolean }>;
  assert.ok(rows.length); assert.ok(rows.every(entry => entry.evidence === "catalog" && entry.uncertain === true));
  assert.equal(rows.find(entry => entry.name === "demo")?.selectionKnown, false);
  assert.deepEqual(rows.find(entry => entry.name === "demo")?.effectiveSelection, { components: [] });
  peer.selection = { components: ["skills"], skills: ["a", "c"] }; peer.effectiveSelection = peer.selection;
  const partial = await recoverLegacyHistory({ source, lock, installed: [anchor, peer], currentNames: new Set(["demo"]), runner: args => { if (args[0] === "clone") cpSync(oldRelease, args.at(-1)!, { recursive: true }); } });
  const row = partial.find(entry => entry.name === "demo") as SourceHistoryEntry & { uncertain?: boolean };
  assert.equal(row.selectionKnown, true); assert.deepEqual(row.selection?.skills, ["a", "c"]); assert.deepEqual(row.effectiveSelection?.skills, ["a", "c"]); assert.equal(row.evidence, "catalog"); assert.equal(row.uncertain, true);
});

test("an empty declared component directory is not installed capability evidence", t => {
  const f = fixture(t); const manifest = readManifest(f.upstream); manifest.hooks = "./hooks/";
  writeFileSync(join(f.upstream, ".agents", ".plugin.json"), JSON.stringify(manifest)); mkdirSync(join(f.upstream, "hooks"));
  installPlugin({ source: f.upstream, pluginsDir: f.store, origin: f.entry.origin, targets: [], selection: { components: ["hooks"] } });
  const lock = readLock(lockPath(f.store)); delete lock.plugins.demo!.selection; delete lock.plugins.demo!.selectionKnown;
  assert.deepEqual(installedHistory(f.store, lock, source)[0]?.effectiveSelection, { components: [] });
});

test("an explicit unchanged reinstall records known requested provenance without changing payload", t => {
  const f = fixture(t, null); delete f.entry.selectionKnown;
  writeLock(lockPath(f.store), f.lock);
  const result = installPlugin({ source: f.upstream, pluginsDir: f.store, origin: f.entry.origin, targets: [], skipUnchanged: true });
  assert.equal(result.changed, false); assert.equal(readLock(lockPath(f.store)).plugins.demo!.selectionKnown, true);
});
