import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installPlugin } from "../src/commands/install.ts";
import { linkPlugins } from "../src/commands/link.ts";
import { unlinkPlugins } from "../src/commands/unlink.ts";
import { syncPlugins } from "../src/commands/sync.ts";
import { marketplaceSync } from "../src/commands/marketplace.ts";
import { pluginStatus } from "../src/commands/status.ts";
import type { Agent, AgentContext, AgentSyncResult } from "../src/agents/index.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";

/**
 * Projection-layer verbs (link/unlink/sync), their source-scoped twin
 * (`marketplace sync`), and the read-only `status` diff. All driven through a
 * recording fake agent so the real Claude/Codex/agy CLIs are never touched.
 */

interface Recorder {
  activate: AgentContext[];
  deactivate: AgentContext[];
  refresh: AgentContext[];
}

/** A fake agent recording each lifecycle call; `installed` backs `listInstalled`. */
function fakeAgent(
  id: string,
  rec: Recorder,
  opts: { installed?: string[]; available?: boolean } = {},
): Agent {
  const available = opts.available ?? true;
  const result = (ctx: AgentContext): AgentSyncResult => ({ agent: id, affected: available ? ctx.plugins : [], skipped: !available });
  return {
    id,
    displayName: id === "codex" ? "Codex" : id === "claude" ? "Claude Code" : "Antigravity",
    adaptTarget: id as "claude" | "codex" | "antigravity",
    detect: () => true,
    available: () => available,
    activate: (ctx) => { rec.activate.push(ctx); return result(ctx); },
    deactivate: (ctx) => { rec.deactivate.push(ctx); return result(ctx); },
    refresh: (ctx) => { rec.refresh.push(ctx); return result(ctx); },
    listInstalled: () => opts.installed,
  };
}

function recorder(): Recorder {
  return { activate: [], deactivate: [], refresh: [] };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-proj-"));
}

/** Install a named plugin (one skill) into the store. */
function seed(store: string, name: string): void {
  const src = tmp();
  mkdirSync(join(src, ".adg-plugin"), { recursive: true });
  writeFileSync(
    join(src, ".adg-plugin", "plugin.json"),
    JSON.stringify({ schemaVersion: ADG_SCHEMA_VERSION, name, version: "0.1.0", description: `${name}.`, skills: "./skills/" }),
  );
  mkdirSync(join(src, "skills", "hello"), { recursive: true });
  writeFileSync(join(src, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: hi.\n---\n");
  installPlugin({ source: src, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  rmSync(src, { recursive: true });
}

// ---- unlink ----

test("unlink deactivates the selected plugin and leaves the store untouched", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  seed(store, "beta");
  const lockBefore = readFileSync(join(store, ".plugin-lock.json"), "utf8");

  const rec = recorder();
  const res = unlinkPlugins({ pluginsDir: store, target: "codex", names: ["alpha"], agent: fakeAgent("codex", rec) });

  assert.deepEqual(res.unlinked, ["alpha"]);
  assert.deepEqual(rec.deactivate.map((c) => c.plugins), [["alpha"]]);
  assert.deepEqual(rec.activate, [], "unlink must not activate");
  // Store is the system of record — unlink never edits it.
  assert.equal(readFileSync(join(store, ".plugin-lock.json"), "utf8"), lockBefore);
  assert.ok(existsSync(join(store, "alpha")), "plugin dir stays installed");
  rmSync(work, { recursive: true });
});

test("unlink with no names targets every installed plugin", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  seed(store, "beta");

  const rec = recorder();
  unlinkPlugins({ pluginsDir: store, target: "codex", agent: fakeAgent("codex", rec) });
  assert.deepEqual(rec.deactivate[0]!.plugins.sort(), ["alpha", "beta"]);
  rmSync(work, { recursive: true });
});

test("unlink rejects an unknown plugin name", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  assert.throws(
    () => unlinkPlugins({ pluginsDir: store, target: "codex", names: ["nope"], agent: fakeAgent("codex", recorder()) }),
    /not installed: nope/,
  );
  rmSync(work, { recursive: true });
});

test("unlink allows deactivating an agent-only plugin (present in agent but not in store)", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");

  const rec = recorder();
  // agent has "gamma" (agent-only, not seeded in store)
  const agent = fakeAgent("codex", rec, { installed: ["gamma"] });
  const res = unlinkPlugins({ pluginsDir: store, target: "codex", names: ["gamma"], agent });

  assert.deepEqual(res.unlinked, ["gamma"]);
  assert.deepEqual(rec.deactivate.map((c) => c.plugins), [["gamma"]]);
  rmSync(work, { recursive: true });
});

test("unlink reports cliSkipped when the agent CLI is unavailable", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  const res = unlinkPlugins({ pluginsDir: store, target: "codex", agent: fakeAgent("codex", recorder(), { available: false }) });
  assert.equal(res.cliSkipped, true);
  assert.deepEqual(res.unlinked, []);
  rmSync(work, { recursive: true });
});

// ---- sync ----

test("sync regenerates the manifest and refreshes (not activates) the plugin", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");

  const rec = recorder();
  const res = syncPlugins({ pluginsDir: store, target: "codex", agent: fakeAgent("codex", rec) });

  assert.equal(res.actions[0]!.name, "alpha");
  assert.equal(res.actions[0]!.synced, true);
  assert.ok(existsSync(join(store, "alpha", ".codex-plugin", "plugin.json")), "manifest regenerated");
  assert.deepEqual(rec.refresh.map((c) => c.plugins), [["alpha"]]);
  assert.deepEqual(rec.activate, [], "sync uses refresh, never activate");
  rmSync(work, { recursive: true });
});

// ---- link subsetting ----

test("link with names acts only on the named subset", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  seed(store, "beta");

  const rec = recorder();
  const res = linkPlugins({ pluginsDir: store, target: "codex", names: ["beta"], agent: fakeAgent("codex", rec) });
  assert.deepEqual(res.actions.map((a) => a.name), ["beta"]);
  assert.deepEqual(rec.activate.map((c) => c.plugins), [["beta"]]);
  rmSync(work, { recursive: true });
});

// ---- marketplace sync ----

test("marketplace sync reconciles every plugin from a source", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha"); // local installs share the "(local)" source bucket
  seed(store, "beta");

  const rec = recorder();
  const res = marketplaceSync({ pluginsDir: store, source: "(local)", target: "codex", agent: fakeAgent("codex", rec) });
  assert.deepEqual(res.actions.map((a) => a.name).sort(), ["alpha", "beta"]);
  assert.deepEqual(rec.refresh[0]!.plugins.sort(), ["alpha", "beta"]);
  rmSync(work, { recursive: true });
});

// ---- status ----

test("status classifies in-sync / missing / agent-only against the store", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");
  seed(store, "beta");

  // Agent has alpha (in sync) + gamma (agent-only); beta is missing from agent.
  const agent = fakeAgent("codex", recorder(), { installed: ["alpha", "gamma"] });
  const [s] = pluginStatus({ pluginsDir: store, scope: "project", agents: [agent] });

  assert.equal(s!.queryable, true);
  assert.deepEqual(s!.inSync, ["alpha"]);
  assert.deepEqual(s!.missing, ["beta"]);
  assert.deepEqual(s!.agentOnly, ["gamma"]);
  rmSync(work, { recursive: true });
});

test("status marks an agent unqueryable when listInstalled returns undefined", () => {
  const work = tmp();
  const store = join(work, "store");
  seed(store, "alpha");

  const agent = fakeAgent("codex", recorder(), { installed: undefined });
  const [s] = pluginStatus({ pluginsDir: store, scope: "project", agents: [agent] });
  assert.equal(s!.queryable, false);
  assert.deepEqual(s!.missing, []);
  rmSync(work, { recursive: true });
});
