import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installPlugin } from "../src/commands/install.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";
import { spawnAdg } from "./sandbox-helpers.mjs";

function run(bin, args, env) {
  const result = spawnSync(bin, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, `${bin} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
}

/*
## Test Intent
### Risk
ADG can write a task-routing description while omitting Codex's native picker
metadata, leaving the selector to show `adg`.

### Why Automation
Only a real Codex process proves that ADG's generated native interface crosses
the runtime boundary into the cache consumed by the picker.

### Why Existing Tests Insufficient
Unit tests validate ADG's manifest projection but do not execute `codex plugin add`.

### Chosen Layer
Integration Test - an isolated CODEX_HOME and ADG_PLUGINS_HOME exercise the
actual CLI without touching the user's real configuration or cache.

### Fragility Analysis
The assertion targets the cached native manifest contract, not terminal
formatting or the interactive UI implementation.

### If Omitted
An ADG-only green suite can ship a catalog that still renders fallback text in
Codex.
*/
const codexAvailable = spawnSync("codex", ["plugin", "--help"], { stdio: "ignore" }).status === 0;

test("Codex sandbox receives picker metadata from adg link", { skip: !codexAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), "adg-codex-description-"));
  const previousCacheHome = process.env.ADG_CACHE_HOME;
  try {
    const store = join(root, ".agents", "plugins");
    const source = join(root, "source");
    mkdirSync(join(source, ".agents"), { recursive: true });
    writeFileSync(join(source, ".agents", ".plugin.json"), JSON.stringify({
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "demo",
      version: "1.0.0",
      description: "Visible sandbox description.",
      skills: "./skills/",
    }));
    mkdirSync(join(source, "skills", "demo"), { recursive: true });
    writeFileSync(join(source, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    installPlugin({ source, pluginsDir: store });

    const marketplaceFile = join(store, "marketplace.json");
    const marketplace = JSON.parse(readFileSync(marketplaceFile, "utf8"));
    marketplace.name = "adg";
    writeFileSync(marketplaceFile, JSON.stringify(marketplace));

    const codexHome = join(root, "codex-home");
    process.env.ADG_CACHE_HOME = join(root, "adg-cache");
    mkdirSync(codexHome, { recursive: true });
    const env = {
      ...process.env,
      ADG_PLUGINS_HOME: store,
      CODEX_HOME: codexHome,
      DISABLE_TELEMETRY: "1",
    };

    run("codex", ["plugin", "marketplace", "add", root], env);
    run("codex", ["plugin", "add", "demo@adg"], env);
    // `--target codex` plus `spawnAdg`'s per-agent isolation (Claude/Antigravity
    // still get throwaway homes here; CODEX_HOME is the one deliberate override,
    // since this test's assertion depends on Codex's real generated cache).
    const { result } = spawnAdg(["plugins", "link", "--target", "codex", "demo", "--global"], {
      isolationRoot: join(root, "other-agent-homes"),
      env: { ADG_PLUGINS_HOME: store, CODEX_HOME: codexHome, DISABLE_TELEMETRY: "1" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const cached = JSON.parse(readFileSync(join(codexHome, "plugins", "cache", "adg", "demo", "1.0.0", ".codex-plugin", "plugin.json"), "utf8"));
    assert.deepEqual(cached.interface, { shortDescription: "Visible sandbox description." });

    const configFile = join(codexHome, "config.toml");
    writeFileSync(configFile, readFileSync(configFile, "utf8") + '\n[desktop]\ntheme = "dark"\n');
    const beforeStatus = readFileSync(configFile, "utf8");
    const beforeCatalog = readFileSync(marketplaceFile, "utf8");
    const cli = (args) => spawnAdg(args, {
      isolationRoot: join(root, "other-agent-homes"),
      env: { ADG_PLUGINS_HOME: store, CODEX_HOME: codexHome, DISABLE_TELEMETRY: "1" },
    }).result;
    const status = cli(["plugins", "status", "--target", "codex", "--global", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).statuses[0].runtimeMissing, []);
    assert.equal(readFileSync(configFile, "utf8"), beforeStatus);
    assert.equal(readFileSync(marketplaceFile, "utf8"), beforeCatalog);

    run("codex", ["plugin", "remove", "demo@adg"], env);
    const enable = cli(["plugins", "enable", "demo", "--global"]);
    assert.equal(enable.status, 0, enable.stderr || enable.stdout);
    const inspect = () => JSON.parse(spawnSync("codex", ["plugin", "list", "--available", "--marketplace", "adg", "--json"], { env, encoding: "utf8" }).stdout);
    assert.equal(inspect().installed[0].enabled, true);
    const healthyConfig = readFileSync(configFile, "utf8");
    assert.equal(cli(["plugins", "enable", "demo", "--global"]).status, 0);
    assert.equal(readFileSync(configFile, "utf8"), healthyConfig);

    writeFileSync(configFile, healthyConfig.replace('[plugins."demo@adg"]\nenabled = true', '[plugins."demo@adg"]\nenabled = false'));
    assert.equal(inspect().installed[0].enabled, false);
    assert.equal(cli(["plugins", "update", "--global", "--repair"]).status, 0);
    assert.equal(inspect().installed[0].enabled, false);
    run("codex", ["plugin", "remove", "demo@adg"], env);
    const repair = cli(["plugins", "update", "--global", "--repair"]);
    assert.equal(repair.status, 0, repair.stderr || repair.stdout);
    assert.equal(inspect().installed[0].enabled, true);
    assert.match(readFileSync(configFile, "utf8"), /theme = "dark"/);

  } finally {
    if (previousCacheHome === undefined) delete process.env.ADG_CACHE_HOME;
    else process.env.ADG_CACHE_HOME = previousCacheHome;
    rmSync(root, { recursive: true, force: true });
  }
});
