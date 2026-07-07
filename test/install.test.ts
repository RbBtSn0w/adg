import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { readManifest } from "../src/manifest.ts";
import { readLock } from "../src/lock.ts";
import { marketplaceSourcePath, pluginSourceCacheDir } from "../src/paths.ts";
import { initPlugin, initScaffold } from "../src/commands/init.ts";
import { adaptPlugin } from "../src/commands/adapt.ts";
import { installPlugin } from "../src/commands/install.ts";
import { updateLock } from "../src/commands/update.ts";
import { cleanPluginCache, directoryBytes, pluginCacheStatus, prunePluginCache } from "../src/commands/cache.ts";
import { validatePlugin } from "../src/commands/validate.ts";
import { type PluginSelection } from "../src/types.ts";
import { tmp, scaffoldSource } from "./helpers.ts";

test("installPlugin records a selection and reuses it on re-install", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "sel", dir: join(work, "src"), description: "Sel." });
  for (const s of ["one", "two"]) {
    mkdirSync(join(pluginDir, "skills", s), { recursive: true });
    writeFileSync(join(pluginDir, "skills", s, "SKILL.md"), "x");
  }
  const store = join(work, "store");

  const selection: PluginSelection = { components: ["skills"], skills: ["one"] };
  installPlugin({ source: pluginDir, pluginsDir: store, selection, now: "2026-06-11T00:00:00Z" });
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(lock.plugins.sel.selection, selection);
  assert.match(lock.plugins.sel.sourceHash, /^sha256-/);
  assert.match(lock.plugins.sel.installedHash, /^sha256-/);
  assert.notEqual(lock.plugins.sel.sourceHash, lock.plugins.sel.installedHash);

  const cache = pluginSourceCacheDir(store, "sel");
  assert.ok(existsSync(join(cache, "skills", "one", "SKILL.md")));
  assert.ok(existsSync(join(cache, "skills", "two", "SKILL.md")), "cache keeps the complete source payload");
  assert.ok(existsSync(join(store, "sel", "skills", "one", "SKILL.md")));
  assert.ok(!existsSync(join(store, "sel", "skills", "two")), "projection excludes unselected skills");
  const codex = JSON.parse(readFileSync(join(store, "sel", ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(codex.skills, ["one"], "generated manifest exposes only the selected skill");

  // Re-install without a selection (e.g. an upgrade) must keep the prior one.
  installPlugin({ source: pluginDir, pluginsDir: store, now: "2026-06-12T00:00:00Z" });
  const lock2 = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(lock2.plugins.sel.selection, selection);

  const changedSelection: PluginSelection = { components: ["skills"], skills: ["two"] };
  installPlugin({ source: pluginDir, pluginsDir: store, selection: changedSelection, now: "2026-06-13T00:00:00Z" });
  assert.ok(!existsSync(join(store, "sel", "skills", "one")), "atomic replacement removes stale selected content");
  assert.ok(existsSync(join(store, "sel", "skills", "two", "SKILL.md")));
  rmSync(work, { recursive: true });
});

test("component selection materializes its declared skill dependencies", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "dependent", dir: join(work, "src"), description: "Dependent." });
  const manifestFile = join(pluginDir, ".agents", ".plugin.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.hooks = "./hooks/";
  manifest.selectionDependencies = { hooks: { skills: ["bootstrap"] } };
  writeFileSync(manifestFile, JSON.stringify(manifest));
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  writeFileSync(join(pluginDir, "hooks", "hooks.json"), "{}");
  mkdirSync(join(pluginDir, "skills", "bootstrap"), { recursive: true });
  writeFileSync(join(pluginDir, "skills", "bootstrap", "SKILL.md"), "# bootstrap\n");

  const store = join(work, "store");
  installPlugin({ source: pluginDir, pluginsDir: store, selection: { components: ["hooks"] } });
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(lock.plugins.dependent.selection, { components: ["hooks"] }, "lock preserves user intent, not derived dependencies");
  assert.ok(existsSync(join(store, "dependent", "hooks", "hooks.json")));
  assert.ok(existsSync(join(store, "dependent", "skills", "bootstrap", "SKILL.md")));

  delete manifest.selectionDependencies;
  writeFileSync(manifestFile, JSON.stringify(manifest));
  installPlugin({ source: pluginDir, pluginsDir: store });
  assert.ok(!existsSync(join(store, "dependent", "skills", "bootstrap")), "dependency removal is recomputed from stored user intent");
  assert.deepEqual(JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8")).plugins.dependent.selection, { components: ["hooks"] });

  manifest.selectionDependencies = { hooks: { skills: ["bootstrap"] } };
  writeFileSync(manifestFile, JSON.stringify(manifest));
  installPlugin({ source: pluginDir, pluginsDir: store, selection: { components: ["skills", "hooks"] } });
  const unrestricted = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(unrestricted.plugins.dependent.selection, { components: ["skills", "hooks"] });
  assert.ok(existsSync(join(store, "dependent", "skills", "getting-started", "SKILL.md")), "dependency closure must not narrow an all-skills selection");
  rmSync(work, { recursive: true, force: true });
});

test("an explicit skill subset always implies the skills component", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "implied-skills", dir: join(work, "src") });
  const store = join(work, "store");
  installPlugin({
    source: pluginDir,
    pluginsDir: store,
    selection: { components: [], skills: ["getting-started"] },
  });
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(lock.plugins["implied-skills"].selection, { components: ["skills"], skills: ["getting-started"] });
  assert.ok(existsSync(join(store, "implied-skills", "skills", "getting-started", "SKILL.md")));
  rmSync(work, { recursive: true, force: true });
});

test("array-form skills reject selected names not declared by the manifest", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "array-skills", dir: join(work, "src") });
  const manifestFile = join(pluginDir, ".agents", ".plugin.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.skills = ["./skills/getting-started"];
  writeFileSync(manifestFile, JSON.stringify(manifest));

  assert.throws(
    () => installPlugin({
      source: pluginDir,
      pluginsDir: join(work, "store"),
      selection: { components: ["skills"], skills: ["missing"] },
    }),
    /selected skill\(s\) not declared: missing/,
  );
  rmSync(work, { recursive: true, force: true });
});

test("cache status, prune, and clean manage source snapshots without touching installations", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "cached", dir: join(work, "src") });
  const store = join(work, "store");
  installPlugin({ source: pluginDir, pluginsDir: store });
  const orphan = join(pluginCacheStatus(store).root, "orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "payload"), "orphan");

  const status = pluginCacheStatus(store);
  assert.deepEqual(status.entries.map((entry) => [entry.name, entry.orphan]), [["cached", false], ["orphan", true]]);
  assert.ok(status.totalBytes > 0);
  assert.deepEqual(prunePluginCache(store), ["orphan"]);
  assert.ok(existsSync(join(store, "cached")));
  cleanPluginCache(store);
  assert.deepEqual(pluginCacheStatus(store).entries, []);
  assert.ok(existsSync(join(store, "cached")), "clean only removes rebuildable cache data");
  rmSync(work, { recursive: true, force: true });
});

test("directoryBytes tolerates a cache directory disappearing during inspection", () => {
  const work = tmp();
  assert.equal(directoryBytes(join(work, "missing")), 0);
  rmSync(work, { recursive: true, force: true });
});

test("failed materialization preserves the previous installation and lock", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "atomic", dir: join(work, "src") });
  const store = join(work, "store");
  installPlugin({ source: pluginDir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  const lockBefore = readFileSync(join(store, ".plugin-lock.json"), "utf8");
  const cacheManifest = join(pluginSourceCacheDir(store, "atomic"), ".agents", ".plugin.json");
  const cacheBefore = readFileSync(cacheManifest, "utf8");
  const installedManifest = join(store, "atomic", ".agents", ".plugin.json");
  const installedBefore = readFileSync(installedManifest, "utf8");

  const sourceManifest = join(pluginDir, ".agents", ".plugin.json");
  const invalid = JSON.parse(readFileSync(sourceManifest, "utf8"));
  invalid.version = "2.0.0";
  invalid.hooks = "./missing-hooks/";
  writeFileSync(sourceManifest, JSON.stringify(invalid));

  assert.throws(() => installPlugin({ source: pluginDir, pluginsDir: store }), /invalid canonical hooks JSON|materialized plugin "atomic" is invalid/);
  assert.equal(readFileSync(installedManifest, "utf8"), installedBefore);
  assert.equal(readFileSync(join(store, ".plugin-lock.json"), "utf8"), lockBefore);
  assert.equal(readFileSync(cacheManifest, "utf8"), cacheBefore);
  rmSync(work, { recursive: true, force: true });
});

test("regular reinstall does not hash the existing projection", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "no-eager-hash", dir: join(work, "src") });
  const store = join(work, "store");
  installPlugin({ source: pluginDir, pluginsDir: store });
  const installedSkill = join(store, "no-eager-hash", "skills", "getting-started", "SKILL.md");
  chmodSync(installedSkill, 0o000);

  try {
    const lock = readLock(join(store, ".plugin-lock.json"));
    assert.doesNotThrow(() => installPlugin({
      source: pluginSourceCacheDir(store, "no-eager-hash"),
      pluginsDir: store,
      origin: lock.plugins["no-eager-hash"]!.origin,
    }));
  } finally {
    if (existsSync(installedSkill)) chmodSync(installedSkill, 0o600);
    rmSync(work, { recursive: true, force: true });
  }
});

test("materialization drops symlinks that escape the plugin source", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "contained", dir: join(work, "src") });
  const secret = join(work, "secret.txt");
  writeFileSync(secret, "secret");
  symlinkSync(secret, join(pluginDir, "skills", "getting-started", "escape.txt"));
  const store = join(work, "store");
  installPlugin({ source: pluginDir, pluginsDir: store });
  assert.ok(!existsSync(join(store, "contained", "skills", "getting-started", "escape.txt")));
  assert.ok(!existsSync(join(pluginSourceCacheDir(store, "contained"), "skills", "getting-started", "escape.txt")));
  rmSync(work, { recursive: true, force: true });
});

test("init -> adapt -> install -> update end to end", () => {
  const work = tmp();
  const pluginsSrc = join(work, "src");
  const { pluginDir } = initPlugin({ name: "sample", dir: pluginsSrc, description: "Sample." });
  assert.ok(existsSync(join(pluginDir, ".agents", ".plugin.json")));

  const adapted = adaptPlugin(pluginDir, ["claude", "codex"]);
  assert.equal(adapted.length, 2);
  assert.ok(existsSync(join(pluginDir, ".claude-plugin", "plugin.json")));
  assert.ok(existsSync(join(pluginDir, ".codex-plugin", "plugin.json")));

  const store = join(work, "store");
  const res = installPlugin({ source: pluginDir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  assert.equal(res.name, "sample");
  assert.equal(res.version, "0.1.0");
  assert.ok(existsSync(join(store, "sample", ".agents", ".plugin.json")));

  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.equal(lock.version, 3);
  assert.equal(lock.plugins.sample.sourceHash, res.sourceHash);
  assert.equal(lock.plugins.sample.installedHash, res.installedHash);
  assert.ok(res.sourceHash.startsWith("sha256-"));
  assert.ok(res.installedHash.startsWith("sha256-"));
  assert.deepEqual(lock.plugins.sample.origin, { type: "local", path: pluginDir });

  // marketplace.json is the de-facto runtime export (no schemaVersion/integrity).
  const market = JSON.parse(readFileSync(join(store, "marketplace.json"), "utf8"));
  assert.equal(market.schemaVersion, undefined);
  assert.equal(market.plugins[0].name, "sample");
  assert.deepEqual(market.plugins[0].source, { source: "local", path: marketplaceSourcePath(store, join(store, "sample")) });

  // No content change => update reports unchanged.
  const upd = updateLock(store, "2026-07-01T00:00:00Z");
  assert.equal(upd.results[0]!.changed, false);

  // Mutate content => update reports changed and refreshes hash.
  writeFileSync(join(pluginDir, "README.md"), "changed");
  const upd2 = updateLock(store, "2026-07-02T00:00:00Z");
  assert.equal(upd2.results[0]!.changed, true);

  rmSync(work, { recursive: true });
});

test("legacy .adg-plugin/plugin.json still resolves and installs", () => {
  const work = tmp();
  const { dir } = scaffoldSource(work, { legacy: true });
  // readManifest falls back to the legacy location.
  assert.equal(readManifest(dir).name, "pkgdemo");
  const store = join(work, "store");
  const res = installPlugin({ source: dir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  assert.equal(res.name, "pkgdemo");
  assert.ok(existsSync(join(store, "pkgdemo", ".agents", ".plugin.json")), "installation emits the canonical manifest");
  rmSync(work, { recursive: true });
});

test("install packages only declared payload, not dev cruft", () => {
  const work = tmp();
  const { dir } = scaffoldSource(work);
  const store = join(work, "store");
  installPlugin({ source: dir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  const out = join(store, "pkgdemo");
  assert.ok(existsSync(join(out, ".agents", ".plugin.json")), "manifest ships");
  assert.ok(existsSync(join(out, "skills", "hello", "SKILL.md")), "declared skill ships");
  assert.ok(existsSync(join(out, "README.md")), "metadata ships");
  assert.ok(!existsSync(join(out, "src")), "src/ excluded");
  assert.ok(!existsSync(join(out, "test")), "test/ excluded");
  assert.ok(!existsSync(join(out, "package.json")), "package.json excluded");
  rmSync(work, { recursive: true });
});

test("install resolves root ./.mcp.json from mcpServers and adapts every runtime", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "mcpkit", dir: work, description: "MCP kit." });
  const mf = join(pluginDir, ".agents", ".plugin.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  m.mcpServers = "./.mcp.json";
  writeFileSync(mf, JSON.stringify(m));
  writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { idocs: { command: "idocs", args: ["mcp"] } } }));

  const store = join(work, "store");
  installPlugin({ source: pluginDir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  const out = join(store, "mcpkit");

  assert.ok(existsSync(join(out, ".mcp.json")), "mcpServers target ships as declared payload");
  const codex = JSON.parse(readFileSync(join(out, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(codex.mcpServers, "./.mcp.json");
  const claude = JSON.parse(readFileSync(join(out, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(claude.mcpServers, "./.mcp.json");
  assert.equal(claude.mcp, undefined);
  const antigravity = JSON.parse(readFileSync(join(out, "plugin.json"), "utf8"));
  assert.deepEqual(antigravity, { name: "mcpkit" });
  assert.deepEqual(
    JSON.parse(readFileSync(join(out, "mcp_config.json"), "utf8")),
    { mcpServers: { idocs: { command: "idocs", args: ["mcp"] } } },
  );
  rmSync(work, { recursive: true });
});

test("initScaffold produces only .agents artifacts (no vendor projections)", () => {
  const work = tmp();

  // plugin (default): just .agents/.plugin.json + skill + README
  const p = initScaffold({ name: "p1", dir: join(work, "p"), type: "plugin" });
  assert.ok(existsSync(join(p.pluginDir, ".agents", ".plugin.json")));
  assert.ok(!existsSync(join(p.pluginDir, ".claude-plugin")), "no claude projection");
  assert.ok(!existsSync(join(p.pluginDir, ".codex-plugin")), "no codex projection");

  // marketplace: a catalog with an empty member list
  const m = initScaffold({ name: "cat", dir: join(work, "m"), type: "marketplace" });
  const catalog = JSON.parse(readFileSync(join(m.pluginDir, ".agents", ".marketplace.json"), "utf8"));
  assert.equal(catalog.name, "cat");
  assert.deepEqual(catalog.plugins, []);
  assert.ok(!existsSync(join(m.pluginDir, ".agents", ".plugin.json")), "marketplace dir is not also a plugin");

  // all: catalog root + one starter member plugin in a subdir, listed in the catalog
  const a = initScaffold({ name: "kit", dir: join(work, "a"), type: "all" });
  const allCatalog = JSON.parse(readFileSync(join(a.pluginDir, ".agents", ".marketplace.json"), "utf8"));
  assert.deepEqual(allCatalog.plugins, [{ name: "kit", source: { source: "local", path: "./kit" } }]);
  assert.ok(existsSync(join(a.pluginDir, "kit", ".agents", ".plugin.json")), "member plugin scaffolded");

  rmSync(work, { recursive: true });
});

test("validatePlugin flags a missing referenced path", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "refcheck", dir: work });
  // Point commands at a non-existent dir.
  const mf = join(pluginDir, ".agents", ".plugin.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  m.commands = "./commands/";
  writeFileSync(mf, JSON.stringify(m));
  const res = validatePlugin(pluginDir);
  assert.equal(res.ok, false);
  assert.ok(res.issues.some((i) => i.includes("commands")));
  rmSync(work, { recursive: true });
});

test("install filters mcp servers when selection specifies a subset", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "mcpkit", dir: work, description: "MCP kit." });
  const mf = join(pluginDir, ".agents", ".plugin.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  m.mcpServers = "./.mcp.json";
  writeFileSync(mf, JSON.stringify(m));
  writeFileSync(
    join(pluginDir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        serverA: { command: "node", args: ["a.js"] },
        serverB: { command: "node", args: ["b.js"] },
      },
    }),
  );

  const store = join(work, "store");
  installPlugin({
    source: pluginDir,
    pluginsDir: store,
    now: "2026-06-11T00:00:00Z",
    selection: {
      components: ["mcp"],
      mcp: ["serverB"],
    },
  });
  const out = join(store, "mcpkit");

  assert.ok(existsSync(join(out, ".mcp.json")), "mcpServers target ships");
  const mcpJson = JSON.parse(readFileSync(join(out, ".mcp.json"), "utf8"));
  assert.deepEqual(mcpJson, {
    mcpServers: {
      serverB: { command: "node", args: ["b.js"] },
    },
  });

  const antigravity = JSON.parse(readFileSync(join(out, "mcp_config.json"), "utf8"));
  assert.deepEqual(antigravity, {
    mcpServers: {
      serverB: { command: "node", args: ["b.js"] },
    },
  });

  rmSync(work, { recursive: true });
});
