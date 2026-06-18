import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { marketplaceSourcePath } from "../src/paths.ts";
import { installPlugin } from "../src/commands/install.ts";
import { removePlugin } from "../src/commands/remove.ts";
import { readMarketplace, emptyMarketplace } from "../src/marketplace.ts";
import { sameSource, ADG_SCHEMA_VERSION } from "../src/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-mkt-"));
}

function writePlugin(dir: string, name: string, version = "1.0.0"): string {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", ".plugin.json"),
    JSON.stringify({
      schemaVersion: ADG_SCHEMA_VERSION,
      name,
      version,
      description: `${name} plugin.`,
      category: "Developer Tools",
      interface: { displayName: name.toUpperCase() },
      skills: "./skills/",
    }),
  );
  return dir;
}

test("sameSource compares discriminated sources structurally", () => {
  assert.ok(sameSource({ type: "local", path: "./a" }, { type: "local", path: "./a" }));
  assert.ok(!sameSource({ type: "local", path: "./a" }, { type: "local", path: "./b" }));
  assert.ok(!sameSource({ type: "local", path: "./a" }, { type: "github", repo: "o/r" }));
  assert.ok(sameSource({ type: "github", repo: "o/r", ref: "x" }, { type: "github", repo: "o/r", ref: "y" }), "ref is not part of identity");
});

test("marketplace.json is a de-facto export; integrity/version live in the lock", () => {
  const work = tmp();
  const store = join(work, "store");
  installPlugin({ source: writePlugin(join(work, "src"), "demo"), pluginsDir: store, now: "2026-06-11T00:00:00Z" });

  // Export: de-facto shape (Codex-compatible), no schemaVersion/integrity/version.
  const market = JSON.parse(readFileSync(join(store, "marketplace.json"), "utf8"));
  assert.equal(market.schemaVersion, undefined);
  const entry = market.plugins[0];
  // Codex resolves source.path relative to the grandparent of marketplace.json.
  assert.deepEqual(entry.source, { source: "local", path: marketplaceSourcePath(store, join(store, "demo")) });
  assert.equal(entry.category, "Developer Tools");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.displayName, undefined);
  assert.equal(entry.integrity, undefined);

  // Control plane: the lock carries integrity + provenance.
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.ok(lock.plugins.demo.folderHash.startsWith("sha256-"));
  assert.deepEqual(lock.plugins.demo.origin, { type: "local", path: "./demo" });
  assert.equal(lock.plugins.demo.version, "1.0.0");
  rmSync(work, { recursive: true });
});

test("installPlugin rejects a same-name plugin from a different source", () => {
  const work = tmp();
  const store = join(work, "store");
  installPlugin({ source: writePlugin(join(work, "a"), "demo"), pluginsDir: store, origin: { type: "github", repo: "owner/a" } });

  // Same name, different upstream origin -> collision.
  assert.throws(
    () => installPlugin({ source: writePlugin(join(work, "b"), "demo"), pluginsDir: store, origin: { type: "github", repo: "owner/b" } }),
    (e: unknown) => e instanceof Error && /name collision/.test((e as Error).message),
  );

  // Re-install from the same origin is fine (idempotent update).
  assert.doesNotThrow(() =>
    installPlugin({ source: writePlugin(join(work, "a"), "demo", "1.1.0"), pluginsDir: store, origin: { type: "github", repo: "owner/a" } }),
  );
  rmSync(work, { recursive: true });
});

test("remote installs nest under a per-marketplace dir; local stays flat", () => {
  const work = tmp();
  const store = join(work, "store");

  installPlugin({ source: writePlugin(join(work, "loc"), "local-one"), pluginsDir: store });
  installPlugin({ source: writePlugin(join(work, "rem"), "remote-one"), pluginsDir: store, origin: { type: "github", repo: "owner/repo" } });

  // Local: flat at <store>/<name>. Remote: nested at <store>/owner__repo/<name>.
  assert.ok(existsSync(join(store, "local-one", ".agents", ".plugin.json")));
  assert.ok(existsSync(join(store, "owner__repo", "remote-one", ".agents", ".plugin.json")));
  assert.ok(!existsSync(join(store, "remote-one")), "remote plugin must not be flat");

  // marketplace.json path tracks the on-disk layout (Codex-compatible).
  const market = JSON.parse(readFileSync(join(store, "marketplace.json"), "utf8"));
  const local = market.plugins.find((p: { name: string }) => p.name === "local-one");
  const remote = market.plugins.find((p: { name: string }) => p.name === "remote-one");
  assert.deepEqual(local.source, { source: "local", path: marketplaceSourcePath(store, join(store, "local-one")) });
  assert.deepEqual(remote.source, { source: "local", path: marketplaceSourcePath(store, join(store, "owner__repo", "remote-one")) });
  rmSync(work, { recursive: true });
});

test("removePlugin locates a nested plugin and prunes the empty bucket", () => {
  const work = tmp();
  const store = join(work, "store");
  installPlugin({ source: writePlugin(join(work, "rem"), "solo"), pluginsDir: store, origin: { type: "github", repo: "owner/repo" } });
  assert.ok(existsSync(join(store, "owner__repo", "solo")));

  const res = removePlugin({ pluginsDir: store, name: "solo" });
  assert.equal(res.removedDir, join(store, "owner__repo", "solo"));
  assert.ok(res.removedFromLock);
  assert.ok(!existsSync(join(store, "owner__repo")), "empty per-marketplace bucket is pruned");
  rmSync(work, { recursive: true });
});

test("readMarketplace is tolerant: keeps unknown fields", () => {
  const work = tmp();
  const file = join(work, "marketplace.json");
  writeFileSync(
    file,
    JSON.stringify({
      name: "legacy",
      futureField: { hello: "world" },
      plugins: [{ name: "demo", source: { source: "local", path: "./demo" }, futureEntryField: 1 }],
    }),
  );
  const market = readMarketplace(file, "fallback") as unknown as Record<string, unknown>;
  assert.equal(market.name, "legacy");
  assert.deepEqual(market.futureField, { hello: "world" }, "unknown fields are preserved");
  rmSync(work, { recursive: true });
});

test("emptyMarketplace has a name and no plugins", () => {
  const m = emptyMarketplace("x");
  assert.equal(m.name, "x");
  assert.deepEqual(m.plugins, []);
});
