import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fromNativeManifest } from "../src/adapters/reverse.ts";
import { toAnthropicManifest } from "../src/adapters/anthropic.ts";
import { toCodexManifest } from "../src/adapters/codex.ts";
import { importSkills } from "../src/commands/import.ts";
import { addPlugins, installPlugin } from "../src/commands/install.ts";
import { linkPlugins } from "../src/commands/link.ts";
import { writeClaudeCatalog, type Agent, type AgentContext, type AgentSyncResult } from "../src/agents/index.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";

/** A fake agent that records activation calls (keeps tests off the real CLIs). */
function fakeAgent(id: string, calls: AgentContext[]): Agent {
  const noop = (): AgentSyncResult => ({ agent: id, affected: [], skipped: false });
  return {
    id,
    displayName: id === "claude" ? "Claude Code" : "Codex",
    adaptTarget: id as "claude" | "codex",
    detect: () => true,
    available: () => true,
    activate: (ctx) => {
      calls.push(ctx);
      return { agent: id, affected: ctx.plugins, skipped: false };
    },
    deactivate: noop,
    refresh: noop,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-imp-"));
}

function writeNative(dir: string, variant: "codex" | "claude", manifest: object, skills: string[]): void {
  const sub = variant === "codex" ? ".codex-plugin" : ".claude-plugin";
  mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, sub, "plugin.json"), JSON.stringify(manifest));
  for (const s of skills) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}.\n---\n`);
  }
}

// ---- reverse adapter ----

test("fromNativeManifest maps codex manifest to ADG", () => {
  const adg = fromNativeManifest(
    { name: "asc", version: "1.2.3", description: "ASC.", skills: ["one", "two"], author: "ADG" },
    "codex",
  );
  assert.equal(adg.schemaVersion, ADG_SCHEMA_VERSION);
  assert.equal(adg.name, "asc");
  assert.equal(adg.version, "1.2.3");
  // Codex bare ids canonicalize to ADG's `./skills/<id>` path-array contract.
  assert.deepEqual(adg.skills, ["./skills/one", "./skills/two"]);
  assert.deepEqual(adg.author, { name: "ADG" });
  // adapters is no longer part of the DSL; reverse-adapt must not emit it.
  assert.ok(!("adapters" in adg));
});

test("fromNativeManifest maps native MCP fields to ADG mcpServers", () => {
  const adg = fromNativeManifest(
    { name: "mcpkit", version: "1.0.0", description: "MCP.", skills: "./skills/", mcpServers: "./.mcp.json" },
    "codex",
  );
  assert.equal(adg.mcpServers, "./.mcp.json");
});

test("fromNativeManifest canonicalizes Windows-style codex skill ids", () => {
  // A native manifest authored on Windows may use backslash separators.
  const adg = fromNativeManifest(
    { name: "win", version: "1.0.0", description: "WIN.", skills: ["skills\\one", "two"] },
    "codex",
  );
  assert.deepEqual(adg.skills, ["./skills/one", "./skills/two"]);
});

test("fromNativeManifest keeps Claude path arrays verbatim", () => {
  const adg = fromNativeManifest(
    { name: "cld", version: "1.0.0", description: "CLD.", skills: ["./skills/one", "./skills/two"] },
    "claude",
  );
  assert.deepEqual(adg.skills, ["./skills/one", "./skills/two"]);
});

test("fromNativeManifest normalizes Windows separators in Claude path arrays", () => {
  // A Claude manifest authored on Windows may use backslash paths; the ADG
  // manifest must stay POSIX-pathed so resolveSkillEntries (splits on /) works.
  const adg = fromNativeManifest(
    { name: "cld", version: "1.0.0", description: "CLD.", skills: [".\\skills\\one", "./skills/two"] },
    "claude",
  );
  assert.deepEqual(adg.skills, ["./skills/one", "./skills/two"]);
});

test("fromNativeManifest carries the apps directory back into ADG", () => {
  const adg = fromNativeManifest(
    { name: "cld", version: "1.0.0", description: "CLD.", apps: "./apps/" },
    "claude",
  );
  assert.equal(adg.apps, "./apps/");
});

test("fromNativeManifest defaults missing version and skills", () => {
  const adg = fromNativeManifest({ name: "x" }, "claude");
  assert.equal(adg.version, "0.0.0");
  assert.equal(adg.skills, "./skills/");
});

// ---- native → ADG → native round-trips ----

/** Seed a plugin dir with the given skill folders so forward adapters can resolve them. */
function seedSkills(dir: string, names: string[]): void {
  for (const s of names) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}.\n---\n`);
  }
}

test("codex skills-array round-trips through ADG to both runtimes", () => {
  const dir = tmp();
  seedSkills(dir, ["one", "two"]);
  // Codex declares bare-id arrays.
  const adg = fromNativeManifest(
    { name: "rt", version: "1.0.0", description: "RT.", skills: ["one", "two"] },
    "codex",
  );

  // Forward to Claude: must emit `./skills/<id>` paths, not the leaked bare ids.
  const claude = toAnthropicManifest(dir, adg).manifest;
  assert.deepEqual(claude.skills, ["./skills/one", "./skills/two"]);

  // Forward back to Codex: array form resolves to bare ids again.
  const codex = toCodexManifest(dir, adg).manifest;
  assert.deepEqual(codex.skills, ["one", "two"]);
  rmSync(dir, { recursive: true });
});

test("claude skills-root round-trips through ADG to both runtimes", () => {
  const dir = tmp();
  seedSkills(dir, ["one", "two"]);
  // A native manifest with no skills declaration normalizes to the `./skills/` root.
  const adg = fromNativeManifest({ name: "rt", version: "1.0.0", description: "RT." }, "claude");
  assert.equal(adg.skills, "./skills/");

  // Strict default: both runtimes pass the root through (directory discovery).
  const claude = toAnthropicManifest(dir, adg).manifest;
  assert.equal(claude.skills, "./skills/");
  const codex = toCodexManifest(dir, adg).manifest;
  assert.equal(codex.skills, "./skills/");
  rmSync(dir, { recursive: true });
});

test("mcp projects to each runtime's native manifest field", () => {
  const dir = tmp();
  seedSkills(dir, ["one"]);
  const adg = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "mcpkit",
    version: "1.0.0",
    description: "MCP.",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  } as const;

  const claude = toAnthropicManifest(dir, adg).manifest;
  assert.equal(claude.mcpServers, "./.mcp.json");
  assert.equal(claude.mcp, undefined);

  const codex = toCodexManifest(dir, adg).manifest;
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.equal(codex.mcp, undefined);
  rmSync(dir, { recursive: true });
});

// ---- import ----

test("add --all converts codex + claude native plugins and installs them", async () => {
  const work = tmp();
  const src = join(work, "repo");
  writeNative(join(src, "plugins", "codexp"), "codex", { name: "codexp", version: "1.0.0", description: "CP", skills: ["a"] }, ["a"]);
  writeNative(join(src, "plugins", "claudep"), "claude", { name: "claudep", version: "2.0.0", description: "CD" }, ["b"]);

  const store = join(work, "store");
  const res = await addPlugins({ spec: src, pluginsDir: store, all: true, now: "2026-06-11T00:00:00Z" });

  assert.deepEqual(res.converted.sort(), ["claudep", "codexp"]);
  assert.equal(res.installed.length, 2);
  assert.ok(existsSync(join(store, "codexp", ".agents", ".plugin.json")));
  assert.ok(existsSync(join(store, "claudep", ".agents", ".plugin.json")));

  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.equal(lock.plugins.codexp.version, "1.0.0");
  assert.equal(lock.plugins.claudep.version, "2.0.0");
  rmSync(work, { recursive: true });
});

test("importSkills wraps a prefixed subset of flat skills into one plugin", () => {
  const work = tmp();
  const skillsDir = join(work, "skills");
  for (const name of ["asc-build", "asc-release", "github-cr"]) {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}.\n---\n`);
  }
  const store = join(work, "store");
  const res = importSkills({ skillsDir, as: "asc", prefix: "asc-", pluginsDir: store, now: "2026-06-11T00:00:00Z" });

  assert.equal(res.name, "asc");
  assert.ok(existsSync(join(store, "asc", "skills", "asc-build", "SKILL.md")));
  assert.ok(existsSync(join(store, "asc", "skills", "asc-release", "SKILL.md")));
  assert.ok(!existsSync(join(store, "asc", "skills", "github-cr")), "prefix filter excludes github-cr");
  rmSync(work, { recursive: true });
});

// ---- link ----

function seedInstalled(store: string): void {
  const src = tmp();
  mkdirSync(join(src, ".adg-plugin"), { recursive: true });
  writeFileSync(
    join(src, ".adg-plugin", "plugin.json"),
    JSON.stringify({ schemaVersion: ADG_SCHEMA_VERSION, name: "demo", version: "0.1.0", description: "Demo.", skills: "./skills/" }),
  );
  mkdirSync(join(src, "skills", "hello"), { recursive: true });
  writeFileSync(join(src, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: hi.\n---\n");
  installPlugin({ source: src, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  rmSync(src, { recursive: true });
}

test("link --target codex regenerates the manifest and activates via the agent", () => {
  const work = tmp();
  const store = join(work, "store");
  seedInstalled(store);
  const calls: AgentContext[] = [];
  const res = linkPlugins({ pluginsDir: store, target: "codex", agent: fakeAgent("codex", calls) });
  assert.equal(res.actions[0]!.name, "demo");
  assert.ok(existsSync(join(store, "demo", ".codex-plugin", "plugin.json")));
  assert.equal(res.actions[0]!.linkedTo, "Codex");
  assert.deepEqual(calls.map((c) => c.plugins), [["demo"]]);
  rmSync(work, { recursive: true });
});

test("link --target claude regenerates the manifest and activates via the agent", () => {
  const work = tmp();
  const store = join(work, "store");
  seedInstalled(store);
  const calls: AgentContext[] = [];
  const res = linkPlugins({ pluginsDir: store, target: "claude", global: true, agent: fakeAgent("claude", calls) });

  assert.ok(existsSync(join(store, "demo", ".claude-plugin", "plugin.json")), "claude manifest regenerated");
  assert.equal(res.actions[0]!.linkedTo, "Claude Code", "reports the agent it was enabled in");
  assert.equal(res.cliSkipped, false);
  assert.deepEqual(calls, [{ pluginsDir: store, plugins: ["demo"], scope: "user" }]);
  rmSync(work, { recursive: true });
});

test("writeClaudeCatalog lists installed plugins with relative sources", () => {
  const work = tmp();
  const store = join(work, "store");
  seedInstalled(store);
  const { file } = writeClaudeCatalog(store, "adg");
  const catalog = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(catalog.name, "adg");
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0].name, "demo");
  assert.equal(catalog.plugins[0].source, "./demo");
  rmSync(work, { recursive: true });
});
