import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spawnAdg } from "./sandbox-helpers.mjs";

test("cache sandbox stores snapshots outside durable plugin state", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-cache-sandbox-"));
  try {
    const source = join(root, "source");
    const store = join(root, "state", "plugins");
    const cache = join(root, "system-cache");
    mkdirSync(join(source, ".agents"), { recursive: true });
    writeFileSync(join(source, ".agents", ".plugin.json"), JSON.stringify({
      schemaVersion: "adg.plugin/v1", name: "cache-demo", version: "1.0.0", description: "Cache sandbox", skills: "./skills/",
    }));
    mkdirSync(join(source, "skills", "demo"), { recursive: true });
    writeFileSync(join(source, "skills", "demo", "SKILL.md"), "# demo\n");
    // `--target codex` restricts activation to Codex alone, and `spawnAdg`
    // additionally isolates every agent's config home (see its doc comment for
    // why this test in particular must never skip that) — so this can never
    // touch the real ~/.claude, ~/.codex, or ~/.gemini on the machine running it.
    const { result, root: isolationRoot } = spawnAdg(["plugins", "add", source, "--dir", store, "--target", "codex"], {
      isolationRoot: join(root, "agent-homes"), // nested under `root` so the `finally` below cleans it up too
      env: { ADG_CACHE_HOME: cache, DISABLE_TELEMETRY: "1" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(join(cache, "plugins")), "snapshot is in the configured system cache");
    assert.ok(!existsSync(join(root, "state", "cache")), "durable state tree does not receive a source cache");
    assert.ok(existsSync(isolationRoot), "agents receive isolated test homes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
