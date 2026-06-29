import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readManifest } from "../src/manifest.ts";
import { marketplaceSourcePath } from "../src/paths.ts";
import { initPlugin, initScaffold } from "../src/commands/init.ts";
import { adaptPlugin } from "../src/commands/adapt.ts";
import { installPlugin } from "../src/commands/install.ts";
import { updateLock } from "../src/commands/update.ts";
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
  const codex = JSON.parse(readFileSync(join(store, "sel", ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(codex.skills, ["one"], "generated manifest exposes only the selected skill");

  // Re-install without a selection (e.g. an upgrade) must keep the prior one.
  installPlugin({ source: pluginDir, pluginsDir: store, now: "2026-06-12T00:00:00Z" });
  const lock2 = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(lock2.plugins.sel.selection, selection);
  rmSync(work, { recursive: true });
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
  assert.ok(existsSync(join(store, "sample", ".agents", ".plugin.json")));

  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.equal(lock.version, 2);
  assert.equal(lock.plugins.sample.folderHash, res.folderHash);
  assert.ok(res.folderHash.startsWith("sha256-"));
  assert.deepEqual(lock.plugins.sample.origin, { type: "local", path: "./sample" });

  // marketplace.json is the de-facto runtime export (no schemaVersion/integrity).
  const market = JSON.parse(readFileSync(join(store, "marketplace.json"), "utf8"));
  assert.equal(market.schemaVersion, undefined);
  assert.equal(market.plugins[0].name, "sample");
  assert.deepEqual(market.plugins[0].source, { source: "local", path: marketplaceSourcePath(store, join(store, "sample")) });

  // No content change => update reports unchanged.
  const upd = updateLock(store, "2026-07-01T00:00:00Z");
  assert.equal(upd.results[0]!.changed, false);

  // Mutate content => update reports changed and refreshes hash.
  writeFileSync(join(store, "sample", "README.md"), "changed");
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
  assert.ok(existsSync(join(store, "pkgdemo", ".adg-plugin", "plugin.json")), "legacy manifest ships");
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
