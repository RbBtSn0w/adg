import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installPlugin } from "../src/commands/install.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";

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
test("Codex sandbox receives picker metadata from adg link", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-codex-description-"));
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
    mkdirSync(codexHome, { recursive: true });
    const env = {
      ...process.env,
      ADG_PLUGINS_HOME: store,
      CODEX_HOME: codexHome,
      DISABLE_TELEMETRY: "1",
    };

    run("codex", ["plugin", "marketplace", "add", root], env);
    run("codex", ["plugin", "add", "demo@adg"], env);
    run(process.execPath, ["bin/adg.ts", "plugins", "link", "--target", "codex", "demo", "--global"], env);

    const cached = JSON.parse(readFileSync(join(codexHome, "plugins", "cache", "adg", "demo", "1.0.0", ".codex-plugin", "plugin.json"), "utf8"));
    assert.deepEqual(cached.interface, { shortDescription: "Visible sandbox description." });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
