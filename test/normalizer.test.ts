import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ADG_MANIFEST_PATH } from "../src/manifest.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";
import { normalizePluginSource } from "../src/normalizer.ts";
import { tmp } from "./helpers.ts";

/*
## Test Intent
### Risk
Plugin discovery, installation, and cache restoration rely on manifest normalization.
If native plugins or Default DSL sources fail to normalize consistently, offline recovery
and local discovery break.
### Why Automation
Ensures single-source-of-truth normalization across ADG, Native, and Default DSL formats.
### Why Existing Tests Insufficient
Existing tests verify reverse-adapter and default-dsl independently, but not through the
unified normalizer facade that cache recovery and discovery now share.
### Chosen Layer
Integration Test - exercises disk-backed directory structures with realistic manifests.
### Fragility Analysis
Relies only on filesystem operations in temporary directories and public exports.
### If Omitted
Drift between installation and cache restoration pipelines can reintroduce recovery failures.
*/
test("normalizer leaves existing authoritative ADG manifest untouched", () => {
  const root = tmp();
  try {
    const manifestPath = join(root, ADG_MANIFEST_PATH);
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "already-adg",
      version: "1.0.0",
      description: "Already ADG",
      skills: "./skills/",
    }));
    mkdirSync(join(root, "skills", "test"), { recursive: true });
    writeFileSync(join(root, "skills", "test", "SKILL.md"), "# Test\n");

    const result = normalizePluginSource(root);
    assert.equal(result.alreadyAdg, true);
    assert.deepEqual(result.adaptedPlugins, []);
    assert.equal(result.synthesizedDefaultDsl, false);
    assert.ok(result.candidates.has("already-adg"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizer adapts native Claude plugin and populates candidates", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "claude-tool",
      version: "2.0.0",
      description: "Claude native",
      skills: "./skills/",
    }));
    writeFileSync(join(root, "skills", "my-skill", "SKILL.md"), "# My Skill\n");

    const result = normalizePluginSource(root);
    assert.equal(result.alreadyAdg, false);
    assert.deepEqual(result.adaptedPlugins, ["claude-tool"]);
    assert.equal(result.synthesizedDefaultDsl, false);
    assert.ok(result.candidates.has("claude-tool"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizer synthesizes Default DSL manifest when definition profile is provided", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "skills", "dsl-skill"), { recursive: true });
    writeFileSync(join(root, "skills", "dsl-skill", "SKILL.md"), "---\ndescription: DSL skill\n---\n# DSL Skill\n");

    const result = normalizePluginSource(root, {
      name: "dsl-plugin",
      definition: {
        kind: "default-dsl/v1",
        root: ".",
        as: "dsl-plugin",
        description: "Synthesized DSL",
        fingerprint: "test-fp",
      },
      recordTelemetry: false,
    });

    assert.equal(result.alreadyAdg, false);
    assert.equal(result.synthesizedDefaultDsl, true);
    assert.ok(result.candidates.has("dsl-plugin"));
    const manifest = JSON.parse(readFileSync(join(root, ADG_MANIFEST_PATH), "utf8"));
    assert.equal(manifest.name, "dsl-plugin");
    assert.equal(manifest.description, "Synthesized DSL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
