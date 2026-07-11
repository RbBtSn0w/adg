import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { marketplaceSourcePath, pluginSourceCacheDir } from "../src/paths.ts";
import { installPlugin } from "../src/commands/install.ts";
import { migrateLayout } from "../src/commands/migrate.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-migrate-"));
}

function writePlugin(dir: string, name: string): string {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", ".plugin.json"),
    JSON.stringify({ schemaVersion: ADG_SCHEMA_VERSION, name, version: "1.0.0", description: `${name}.`, skills: "./skills/" }),
  );
  return dir;
}

test("migrateLayout moves a flat remote install into its per-marketplace bucket", () => {
  const work = tmp();
  const store = join(work, "store");

  // Install a remote plugin, then simulate the old flat layout by moving it back
  // to <store>/<name> (and rewriting marketplace.json to the old flat path).
  installPlugin({ source: writePlugin(join(work, "rem"), "demo"), pluginsDir: store, origin: { type: "github", repo: "owner/repo" } });
  const nested = join(store, "owner__repo", "demo");
  const flat = join(store, "demo");
  renameSync(nested, flat);
  rmSync(join(store, "owner__repo"), { recursive: true, force: true });
  const marketFile = join(store, "marketplace.json");
  const market = JSON.parse(readFileSync(marketFile, "utf8"));
  market.plugins[0].source.path = "./demo";
  writeFileSync(marketFile, JSON.stringify(market));

  const res = migrateLayout(store);

  assert.equal(res.moved.length, 1);
  assert.equal(res.moved[0]!.name, "demo");
  assert.ok(existsSync(nested), "plugin moved into the nested bucket");
  assert.ok(!existsSync(flat), "old flat dir is gone");
  const after = JSON.parse(readFileSync(marketFile, "utf8"));
  assert.equal(after.plugins[0].source.path, marketplaceSourcePath(store, join(store, "owner__repo", "demo")));
  rmSync(work, { recursive: true });
});

test("migrateLayout leaves local installs flat and is idempotent", () => {
  const work = tmp();
  const store = join(work, "store");
  installPlugin({ source: writePlugin(join(work, "loc"), "demo"), pluginsDir: store });

  const first = migrateLayout(store);
  assert.deepEqual(first.moved, []);
  assert.deepEqual(first.unchanged, ["demo"]);
  assert.ok(existsSync(join(store, "demo")), "local stays flat");

  // Idempotent: running again is a no-op.
  const second = migrateLayout(store);
  assert.deepEqual(second.moved, []);
  rmSync(work, { recursive: true });
});

test("migrateLayout upgrades v2 locks without losing unselected source payload", () => {
  const work = tmp();
  const store = join(work, "store");
  const installed = writePlugin(join(store, "demo"), "demo");
  mkdirSync(join(installed, "skills", "chosen"), { recursive: true });
  mkdirSync(join(installed, "skills", "other"), { recursive: true });
  mkdirSync(join(installed, "hooks"), { recursive: true });
  writeFileSync(join(installed, "skills", "chosen", "SKILL.md"), "chosen\n");
  writeFileSync(join(installed, "skills", "other", "SKILL.md"), "other\n");
  writeFileSync(join(installed, "hooks", "hooks.json"), "{}\n");
  const manifestFile = join(installed, ".agents", ".plugin.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.hooks = "./hooks/hooks.json";
  writeFileSync(manifestFile, JSON.stringify(manifest));
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, ".plugin-lock.json"), JSON.stringify({
    version: 2,
    plugins: {
      demo: {
        origin: { type: "local", path: installed },
        version: "1.0.0",
        folderHash: "sha256-legacy",
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        selection: { components: ["skills"], skills: ["chosen"] },
        state: "disabled",
      },
    },
    lastSelected: ["demo"],
  }, null, 2));

  const res = migrateLayout(store);

  assert.deepEqual(res.moved, []);
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.equal(lock.version, 4);
  assert.match(lock.plugins.demo.sourceHash, /^sha256-/);
  assert.match(lock.plugins.demo.installedHash, /^sha256-/);
  assert.equal(lock.plugins.demo.installedAt, "2026-01-01T00:00:00Z");
  assert.equal(lock.plugins.demo.updatedAt, "2026-02-01T00:00:00Z");
  assert.equal(lock.plugins.demo.state, "disabled");
  assert.ok(existsSync(join(installed, "skills", "chosen", "SKILL.md")));
  assert.ok(!existsSync(join(installed, "skills", "other")), "projection excludes unselected skill");
  assert.ok(!existsSync(join(installed, "hooks")), "projection excludes unselected hooks");
  const cache = pluginSourceCacheDir(store, "demo");
  assert.ok(existsSync(join(cache, "skills", "chosen", "SKILL.md")));
  assert.ok(existsSync(join(cache, "skills", "other", "SKILL.md")), "cache preserves unselected skill");
  assert.ok(existsSync(join(cache, "hooks", "hooks.json")), "cache preserves unselected hooks");
  rmSync(work, { recursive: true });
});

test("v2 migration is retryable after a later plugin fails", () => {
  const work = tmp();
  const store = join(work, "store");
  const first = writePlugin(join(store, "first"), "first");
  mkdirSync(join(first, "skills", "chosen"), { recursive: true });
  mkdirSync(join(first, "skills", "other"), { recursive: true });
  writeFileSync(join(first, "skills", "chosen", "SKILL.md"), "chosen\n");
  writeFileSync(join(first, "skills", "other", "SKILL.md"), "other\n");
  const second = join(store, "second");
  mkdirSync(second, { recursive: true });
  const legacyLock = {
    version: 2,
    plugins: Object.fromEntries(["first", "second"].map((name) => [name, {
      origin: { type: "local", path: join(store, name) },
      version: "1.0.0",
      folderHash: "sha256-legacy",
      installedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      selection: { components: ["skills"], skills: ["chosen"] },
    }])),
  };
  writeFileSync(join(store, ".plugin-lock.json"), JSON.stringify(legacyLock, null, 2));

  assert.throws(() => migrateLayout(store), /manifest/i);
  assert.equal(JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8")).version, 2);
  assert.ok(!existsSync(join(first, "skills", "other")), "first projection was already materialized");
  assert.ok(existsSync(join(pluginSourceCacheDir(store, "first"), "skills", "other", "SKILL.md")));

  writePlugin(second, "second");
  mkdirSync(join(second, "skills", "chosen"), { recursive: true });
  writeFileSync(join(second, "skills", "chosen", "SKILL.md"), "chosen\n");
  migrateLayout(store);

  assert.equal(JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8")).version, 4);
  assert.ok(existsSync(join(pluginSourceCacheDir(store, "first"), "skills", "other", "SKILL.md")), "retry reuses complete cache");
  rmSync(work, { recursive: true });
});
