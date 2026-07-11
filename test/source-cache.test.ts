import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { installPlugin } from "../src/commands/install.ts";
import { resolvePluginSourceSnapshot } from "../src/source-cache.ts";
import { legacyPluginSourceCacheDir, pluginSourceCacheDir } from "../src/paths.ts";
import { readLock } from "../src/lock.ts";
import { initPlugin } from "../src/commands/init.ts";
import { tmp } from "./helpers.ts";

test("source snapshot adopts a verified legacy cache into the system cache", () => {
  const work = tmp();
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "legacy-cache", dir: join(work, "source") });
  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["legacy-cache"]!;
  const cache = pluginSourceCacheDir(store, "legacy-cache");
  const legacy = legacyPluginSourceCacheDir(store, "legacy-cache");
  mkdirSync(join(legacy, ".."), { recursive: true });
  // The installed cache is known-good; moving it models an old ADG install.
  rmSync(cache, { recursive: true, force: true });
  cpSync(pluginDir, legacy, { recursive: true });

  assert.equal(resolvePluginSourceSnapshot(store, "legacy-cache", entry), cache);
  assert.ok(existsSync(cache));
  rmSync(work, { recursive: true, force: true });
});

test("source snapshot rejects a cache whose full-payload hash no longer matches the lock", () => {
  const work = tmp();
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "tampered-cache", dir: join(work, "source") });
  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["tampered-cache"]!;
  writeFileSync(join(pluginSourceCacheDir(store, "tampered-cache"), "README.md"), "tampered");

  assert.throws(() => resolvePluginSourceSnapshot(store, "tampered-cache", entry), /source cache integrity mismatch/);
  rmSync(work, { recursive: true, force: true });
});

test("source snapshot repopulates the system cache from a verified local origin", () => {
  const work = tmp();
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "local-cache", dir: join(work, "source") });
  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["local-cache"]!;
  const cache = pluginSourceCacheDir(store, "local-cache");
  rmSync(cache, { recursive: true, force: true });

  assert.equal(resolvePluginSourceSnapshot(store, "local-cache", entry), cache);
  assert.ok(existsSync(cache));
  rmSync(work, { recursive: true, force: true });
});
