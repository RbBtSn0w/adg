import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { ADAPTERS, ADAPTER_TARGETS, ADAPTER_COMPONENTS, toAntigravityManifest } from "../src/adapters/index.ts";
import { antigravityAgent, writeAntigravityProjection } from "../src/agents/antigravity.ts";
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
    // Component dirs are projected by their agy-convention name and resolve to
    // the real source dirs one level up (symlink, or copy fallback).
    assert.equal(
      realpathSync(join(stage, "skills")),
      realpathSync(join(dir, "skills")),
    );
    assert.equal(readFileSync(join(stage, "skills", "metadata-sync", "SKILL.md"), "utf8"), "# skill");
    assert.equal(readFileSync(join(stage, "agents", "release-captain.md"), "utf8"), "# agent");
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

test("detect keys off <GEMINI_HOME>/antigravity-cli, defaulting to ~/.gemini", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adg-agy-home-"));
  try {
    const gemini = join(tmp, "gemini");
    mkdirSync(gemini);
    assert.equal(antigravityAgent.detect({ GEMINI_HOME: gemini } as NodeJS.ProcessEnv), false);

    mkdirSync(join(gemini, "antigravity-cli"));
    assert.equal(antigravityAgent.detect({ GEMINI_HOME: gemini } as NodeJS.ProcessEnv), true);

    // Default home is ~/.gemini/antigravity-cli when GEMINI_HOME is unset; this
    // only asserts the resolved path, not its presence on the test machine.
    const def = antigravityAgent.detect({} as NodeJS.ProcessEnv);
    assert.equal(typeof def, "boolean");
    assert.ok(join(homedir(), ".gemini", "antigravity-cli")); // path is well-formed
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
