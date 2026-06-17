import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { marketplaceSourcePath } from "../src/paths.ts";
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
