import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { ADAPTERS, ADAPTER_TARGETS, ADAPTER_COMPONENTS, toAntigravityManifest } from "../src/adapters/index.ts";
import { antigravityAgent, antigravityHome, writeAntigravityProjection } from "../src/agents/antigravity.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";

/**
 * Antigravity (`agy`, Google's agent CLI) is a third runtime target. It discovers
 * a plugin by convention relative to the install dir (a minimal `plugin.json`
 * plus sibling component dirs and a `mcp_config.json`), so ADG projects a
 * self-contained agy plugin root under `.antigravity-plugin/`: generated
 * manifests + symlinks to the real component dirs. These guard the adapter
 * output, that projection (mcp passthrough + component links), and detection.
 */

const PROJ = ".antigravity-plugin";

function writePlugin(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", ".plugin.json"), JSON.stringify(manifest));
}

test("antigravity is a registered adapter target with the Claude component superset", () => {
  assert.ok(ADAPTER_TARGETS.includes("antigravity"));
  assert.equal(ADAPTERS.antigravity, toAntigravityManifest);
  assert.equal(ADAPTERS.agy, toAntigravityManifest); // alias
  assert.deepEqual(ADAPTER_COMPONENTS.antigravity, ["skills", "agents", "commands", "hooks", "mcp"]);
});

test("toAntigravityManifest emits .antigravity-plugin/plugin.json carrying only the name", () => {
  const m = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "asc",
    version: "0.1.0",
    description: "x",
    mcp: "./mcp/.mcp.json",
  } as const;
  const out = toAntigravityManifest("/tmp/asc", m, undefined);
  assert.equal(out.defaultPath, join(PROJ, "plugin.json"));
  assert.deepEqual(out.manifest, { name: "asc" });
});

test("writeAntigravityProjection builds a self-contained agy root: manifest, mcp passthrough, and component links", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-"));
  try {
    const mcp = { mcpServers: { asc: { command: "asc", args: ["mcp", "serve"] } } };
    writePlugin(dir, {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "asc",
      version: "0.1.0",
      description: "App Store Connect",
      skills: "./skills/",
      agents: "./agents/",
      mcp: "./mcp/.mcp.json",
    });
    mkdirSync(join(dir, "mcp"), { recursive: true });
    writeFileSync(join(dir, "mcp", ".mcp.json"), JSON.stringify(mcp));
    mkdirSync(join(dir, "skills", "metadata-sync"), { recursive: true });
    writeFileSync(join(dir, "skills", "metadata-sync", "SKILL.md"), "# skill");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "release-captain.md"), "# agent");

    writeAntigravityProjection(dir);

    const stage = join(dir, PROJ);
    assert.deepEqual(JSON.parse(readFileSync(join(stage, "plugin.json"), "utf8")), { name: "asc" });
    // The ADG mcp shape is exactly agy's, so it passes through unchanged.
    assert.deepEqual(JSON.parse(readFileSync(join(stage, "mcp_config.json"), "utf8")), mcp);
    // Skills are projected per-skill into a real `skills/` dir, each entry
    // resolving to its real source dir (symlink, or copy fallback).
    assert.equal(
      realpathSync(join(stage, "skills", "metadata-sync")),
      realpathSync(join(dir, "skills", "metadata-sync")),
    );
    assert.equal(readFileSync(join(stage, "skills", "metadata-sync", "SKILL.md"), "utf8"), "# skill");
    // Single-dir components are linked wholesale under their agy-convention name.
    assert.equal(realpathSync(join(stage, "agents")), realpathSync(join(dir, "agents")));
    assert.equal(readFileSync(join(stage, "agents", "release-captain.md"), "utf8"), "# agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAntigravityProjection honors a partial-install selection (components + skill subset)", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-"));
  try {
    const mcp = { mcpServers: { asc: { command: "asc" } } };
    writePlugin(dir, {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "asc",
      version: "0.1.0",
      description: "App Store Connect",
      skills: "./skills/",
      agents: "./agents/",
      mcp: "./mcp/.mcp.json",
    });
    mkdirSync(join(dir, "mcp"), { recursive: true });
    writeFileSync(join(dir, "mcp", ".mcp.json"), JSON.stringify(mcp));
    for (const s of ["keep", "drop"]) {
      mkdirSync(join(dir, "skills", s), { recursive: true });
      writeFileSync(join(dir, "skills", s, "SKILL.md"), `# ${s}`);
    }
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "a.md"), "# a");

    // Expose only skills (subset "keep") — agents and mcp are not selected.
    writeAntigravityProjection(dir, { components: ["skills"], skills: ["keep"] });

    const stage = join(dir, PROJ);
    assert.equal(readFileSync(join(stage, "skills", "keep", "SKILL.md"), "utf8"), "# keep");
    assert.throws(() => realpathSync(join(stage, "skills", "drop")));
    assert.throws(() => realpathSync(join(stage, "agents")));
    assert.throws(() => readFileSync(join(stage, "mcp_config.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAntigravityProjection links every root of a multi-root skills path-list", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-"));
  try {
    writePlugin(dir, {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "multi",
      version: "0.1.0",
      description: "multi-root skills",
      skills: ["./skills/one", "./extra/two"],
    });
    mkdirSync(join(dir, "skills", "one"), { recursive: true });
    writeFileSync(join(dir, "skills", "one", "SKILL.md"), "# one");
    mkdirSync(join(dir, "extra", "two"), { recursive: true });
    writeFileSync(join(dir, "extra", "two", "SKILL.md"), "# two");

    writeAntigravityProjection(dir);

    const stage = join(dir, PROJ);
    // The second root must not be silently dropped.
    assert.equal(readFileSync(join(stage, "skills", "one", "SKILL.md"), "utf8"), "# one");
    assert.equal(readFileSync(join(stage, "skills", "two", "SKILL.md"), "utf8"), "# two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAntigravityProjection omits mcp_config.json when the plugin declares no mcp", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-"));
  try {
    writePlugin(dir, {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "skills-only",
      version: "0.1.0",
      description: "no mcp",
      skills: "./skills/",
    });
    mkdirSync(join(dir, "skills", "s"), { recursive: true });
    writeFileSync(join(dir, "skills", "s", "SKILL.md"), "# s");

    writeAntigravityProjection(dir);

    const stage = join(dir, PROJ);
    assert.deepEqual(JSON.parse(readFileSync(join(stage, "plugin.json"), "utf8")), { name: "skills-only" });
    assert.throws(() => readFileSync(join(stage, "mcp_config.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("antigravityHome resolves <GEMINI_HOME>/antigravity-cli, defaulting to ~/.gemini", () => {
  // Exercise the production resolver directly (no filesystem state needed).
  assert.equal(antigravityHome({ GEMINI_HOME: "/tmp/g" } as NodeJS.ProcessEnv), join("/tmp/g", "antigravity-cli"));
  assert.equal(antigravityHome({} as NodeJS.ProcessEnv), join(homedir(), ".gemini", "antigravity-cli"));
});

test("detect keys off <GEMINI_HOME>/antigravity-cli", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adg-agy-home-"));
  try {
    const gemini = join(tmp, "gemini");
    mkdirSync(gemini);
    assert.equal(antigravityAgent.detect({ GEMINI_HOME: gemini } as NodeJS.ProcessEnv), false);

    mkdirSync(join(gemini, "antigravity-cli"));
    assert.equal(antigravityAgent.detect({ GEMINI_HOME: gemini } as NodeJS.ProcessEnv), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
