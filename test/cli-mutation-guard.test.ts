import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlugins } from "../src/cli/handlers.ts";
import { prepareMigrationTransaction, discoverPendingMigrations } from "../src/migration-transaction.ts";
import { withStoreMutex } from "../src/store-mutex.ts";

test("all scoped mutations reject pending migrations while help and list remain readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-cli-pending-"));
  const previous = process.env.ADG_MIGRATION_HOME;
  process.env.ADG_MIGRATION_HOME = join(root, "private");
  const store = join(root, "store");
  mkdirSync(store);
  const output = console.log;
  console.log = () => {};
  try {
    await prepareMigrationTransaction({ pluginsDir: store, source: "synthetic", revision: "fixed", prepared: [], retire: [], scope: "project" });
    const mutations: Array<[string, string[]]> = [
      ["add", [root, "--all"]], ["remove", ["old"]], ["enable", ["old"]], ["disable", ["old"]],
      ["link", ["--target", "claude"]], ["unlink", ["--target", "claude"]], ["sync", ["--target", "claude"]],
      ["migrate", []], ["import-skills", [root, "--as", "old"]],
      ["cache", ["prune"]], ["cache", ["clean", "--force"]], ["cache", ["restore"]],
      ["marketplace", ["remove", "synthetic"]], ["marketplace", ["sync", "synthetic", "--target", "claude"]],
    ];
    for (const [verb, args] of mutations) {
      await assert.rejects(runPlugins(verb, [...args, "--dir", store]), /migration is pending/, verb);
    }
    assert.equal((await runPlugins("remove", ["--help"])).exitCode, 0);
    assert.equal((await runPlugins("list", ["--dir", store, "--json"])).exitCode, 0);
    assert.equal(discoverPendingMigrations(store).length, 1);
  } finally {
    console.log = output;
    if (previous === undefined) delete process.env.ADG_MIGRATION_HOME;
    else process.env.ADG_MIGRATION_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutating CLI waits for the shared mutex before examining store state", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-cli-mutex-"));
  let release!: () => void;
  let entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const held = withStoreMutex(root, async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await acquired;
  let settled = false;
  const output = console.log;
  console.log = () => {};
  try {
    const mutation = runPlugins("cache", ["prune", "--dir", root]).then(result => { settled = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    await held;
    assert.equal((await mutation).exitCode, 0);
  } finally {
    release();
    await held;
    console.log = output;
    rmSync(root, { recursive: true, force: true });
  }
});
