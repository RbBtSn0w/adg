import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("cache sandbox stores snapshots outside durable plugin state", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-cache-sandbox-"));
  try {
    const source = join(root, "source");
    const store = join(root, "state", "plugins");
    const cache = join(root, "system-cache");
    const codexHome = join(root, "codex-home");
    mkdirSync(join(source, ".agents"), { recursive: true });
    writeFileSync(join(source, ".agents", ".plugin.json"), JSON.stringify({
      schemaVersion: "adg.plugin/v1", name: "cache-demo", version: "1.0.0", description: "Cache sandbox", skills: "./skills/",
    }));
    mkdirSync(join(source, "skills", "demo"), { recursive: true });
    writeFileSync(join(source, "skills", "demo", "SKILL.md"), "# demo\n");
    mkdirSync(codexHome, { recursive: true });
    const result = spawnSync(process.execPath, ["bin/adg.ts", "plugins", "add", source, "--dir", store, "--target", "codex"], {
      env: { ...process.env, ADG_CACHE_HOME: cache, CODEX_HOME: codexHome, DISABLE_TELEMETRY: "1" }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(join(cache, "plugins")), "snapshot is in the configured system cache");
    assert.ok(!existsSync(join(root, "state", "cache")), "durable state tree does not receive a source cache");
    assert.ok(existsSync(codexHome), "Codex receives an isolated test home");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
