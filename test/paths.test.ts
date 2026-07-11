import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codexMarketplaceRoot, globalPluginsDir, legacyPluginCacheRoot, marketplaceSourcePath, pluginCacheRoot, pluginRematerializationSource, projectPluginsDir } from "../src/paths.ts";
import { emptyLock, readLock, upsertEntry } from "../src/lock.ts";
import { tmp } from "./helpers.ts";

test("marketplaceSourcePath is relative to the marketplace.json grandparent (codex convention)", () => {
  const pdir = "/root/.agents/plugins";
  assert.equal(marketplaceSourcePath(pdir, "/root/.agents/plugins/foo"), "./.agents/plugins/foo");
  assert.equal(marketplaceSourcePath(pdir, "/root/.agents/plugins/owner__repo/bar"), "./.agents/plugins/owner__repo/bar");
});

test("codexMarketplaceRoot resolves the project root for canonical .agents/plugins stores", () => {
  assert.equal(codexMarketplaceRoot("/repo/.agents/plugins"), "/repo");
  assert.equal(codexMarketplaceRoot("/repo/custom-store"), "/repo/custom-store");
});

test("marketplaceSourcePath is relative to a non-canonical store dir (explicit --dir)", () => {
  // A custom `--dir` store has no `.agents/` ancestor, so the path is relative
  // to the store itself — not a fixed two-levels-up that leaks parent names.
  const flat = "/cwd/store";
  assert.equal(marketplaceSourcePath(flat, "/cwd/store/myplug"), "./myplug");
  assert.equal(marketplaceSourcePath(flat, "/cwd/store/owner__repo/bar"), "./owner__repo/bar");

  const deep = "/cwd/a/b/c";
  assert.equal(marketplaceSourcePath(deep, "/cwd/a/b/c/myplug"), "./myplug");

  // The repo's own reference store `<repo>/plugins` resolves to `./<name>`.
  assert.equal(marketplaceSourcePath("/repo/plugins", "/repo/plugins/asc"), "./asc");
});

test("globalPluginsDir honors env precedence", () => {
  assert.equal(globalPluginsDir({ ADG_PLUGINS_HOME: "/x" } as NodeJS.ProcessEnv), "/x");
  assert.ok(globalPluginsDir({ XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv).startsWith("/state"));
});

test("plugin cache uses the platform cache root and keeps stores isolated", () => {
  const env = { ADG_CACHE_HOME: "/cache/adg" } as NodeJS.ProcessEnv;
  assert.match(pluginCacheRoot("/one/.agents/plugins", env, "darwin"), /^\/cache\/adg\/plugins\//);
  assert.notEqual(
    pluginCacheRoot("/one/.agents/plugins", env, "darwin"),
    pluginCacheRoot("/two/.agents/plugins", env, "darwin"),
  );
  assert.equal(legacyPluginCacheRoot("/one/.agents/plugins"), "/one/.agents/cache/plugins/" + basename(pluginCacheRoot("/one/.agents/plugins", env, "darwin")));
});

test("projectPluginsDir stops at a .git root", () => {
  const root = tmp();
  mkdirSync(join(root, ".git"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(projectPluginsDir(nested), join(root, ".agents", "plugins"));
  rmSync(root, { recursive: true });
});

test("pluginRematerializationSource resolves legacy local origins from the store", () => {
  const root = tmp();
  const store = join(root, "plugins");
  const source = join(store, "legacy-source");
  mkdirSync(source, { recursive: true });
  assert.equal(
    pluginRematerializationSource(store, "demo", { type: "local", path: "./legacy-source" }),
    source,
  );
  rmSync(root, { recursive: true });
});

test("upsertEntry preserves installedAt and refreshes updatedAt", () => {
  const lock = emptyLock();
  upsertEntry(lock, "demo", { origin: { type: "local", path: "./demo" }, version: "1.0.0", sourceHash: "sha256-aa", installedHash: "sha256-ia" }, "2026-01-01T00:00:00Z");
  upsertEntry(lock, "demo", { origin: { type: "local", path: "./demo" }, version: "1.0.1", sourceHash: "sha256-bb", installedHash: "sha256-ib" }, "2026-02-01T00:00:00Z");
  assert.equal(lock.plugins.demo!.installedAt, "2026-01-01T00:00:00Z");
  assert.equal(lock.plugins.demo!.updatedAt, "2026-02-01T00:00:00Z");
  assert.deepEqual(lock.lastSelected, ["demo"]);
});

test("readLock rejects unsupported versions instead of carrying compatibility code", () => {
  const root = tmp();
  const file = join(root, ".plugin-lock.json");
  writeFileSync(file, JSON.stringify({ version: 2, plugins: {} }));
  assert.throws(() => readLock(file), /unsupported lock version 2; expected 4/);
  rmSync(root, { recursive: true });
});
