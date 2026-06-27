import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { ADAPTERS, ADAPTER_TARGETS, ADAPTER_COMPONENTS, toAntigravityManifest } from "../src/adapters/index.ts";
import { antigravityAgent, antigravityGlobalPluginsDir, ensureAntigravityRoot } from "../src/agents/antigravity.ts";
import { writeLock } from "../src/lock.ts";
import { lockPath } from "../src/paths.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";

/**
 * Antigravity (`agy`) is discovered by *scanning* directories — the directory is
 * the scope/provenance, there is no agy CLI, lock, or marketplace. ADG makes a
 * plugin folder a valid agy root in place (root `plugin.json` + sibling component
 * dirs) and, for global / remote-nested plugins, exposes it via a symlink into
 * the scan dir. These guard the adapter output, the in-place projection, scope
 * isolation (no cross-scope leak), and detection.
 */

function writePlugin(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", ".plugin.json"), JSON.stringify(manifest));
}

/** Seed a store dir with one local plugin folder + a lock entry for it. */
function seedStore(store: string, name: string, manifest: Record<string, unknown>): string {
  const dir = join(store, name);
  writePlugin(dir, manifest);
  writeLock(lockPath(store), {
    version: 2,
    plugins: {
      [name]: {
        origin: { type: "local", path: `./${name}` },
        version: "1.0.0",
        folderHash: "sha256-test",
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
  return dir;
}

/** Run `fn` with GEMINI_HOME pointed at a real tmp dir so the agent detects Antigravity. */
function withGemini<T>(fn: (gemini: string) => T): T {
  const prev = process.env.GEMINI_HOME;
  const gemini = mkdtempSync(join(tmpdir(), "adg-gemini-"));
  mkdirSync(join(gemini, "antigravity")); // the Antigravity-specific detection marker
  process.env.GEMINI_HOME = gemini;
  try {
    return fn(gemini);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
    rmSync(gemini, { recursive: true, force: true });
  }
}

test("antigravity is a registered adapter target with the Claude component superset", () => {
  assert.ok(ADAPTER_TARGETS.includes("antigravity"));
  assert.equal(ADAPTERS.antigravity, toAntigravityManifest);
  assert.equal(ADAPTERS.agy, toAntigravityManifest); // alias
  assert.deepEqual(ADAPTER_COMPONENTS.antigravity, ["skills", "agents", "commands", "hooks", "mcp"]);
});

test("toAntigravityManifest emits a root plugin.json with shared mcpServers", () => {
  const m = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "asc",
    version: "0.1.0",
    description: "x",
    mcpServers: "./.mcp.json",
  } as const;
  const out = toAntigravityManifest("/tmp/asc", m, undefined);
  assert.equal(out.defaultPath, "plugin.json");
  assert.deepEqual(out.manifest, { name: "asc", mcpServers: "./.mcp.json" });
});

test("ensureAntigravityRoot writes the agy manifest at the folder root, in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-"));
  try {
    writePlugin(dir, {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "asc",
      version: "0.1.0",
      description: "App Store Connect",
      skills: "./skills/",
      agents: "./agents/",
      mcpServers: "./.mcp.json",
    });
    mkdirSync(join(dir, "skills", "metadata-sync"), { recursive: true });
    writeFileSync(join(dir, "skills", "metadata-sync", "SKILL.md"), "# skill");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "release-captain.md"), "# agent");

    ensureAntigravityRoot(dir);

    assert.deepEqual(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")), { name: "asc", mcpServers: "./.mcp.json" });
    // Convention-named component dirs are read in place (no alias, no copy).
    assert.equal(readFileSync(join(dir, "skills", "metadata-sync", "SKILL.md"), "utf8"), "# skill");
    assert.equal(readFileSync(join(dir, "agents", "release-captain.md"), "utf8"), "# agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAntigravityRoot aliases a non-convention component dir to its convention name", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-"));
  try {
    writePlugin(dir, {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "bots",
      version: "0.1.0",
      description: "non-convention agents dir",
      agents: "./bots/",
    });
    mkdirSync(join(dir, "bots"), { recursive: true });
    writeFileSync(join(dir, "bots", "a.md"), "# a");

    ensureAntigravityRoot(dir);

    // agy reads `<dir>/agents`; it must resolve to the real `bots/` source.
    assert.equal(realpathSync(join(dir, "agents")), realpathSync(join(dir, "bots")));
    assert.equal(readFileSync(join(dir, "agents", "a.md"), "utf8"), "# a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAntigravityRoot drops mcpServers when mcp is not exposed (dirs stay full: in-place tradeoff)", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-"));
  try {
    writePlugin(dir, {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "asc",
      version: "0.1.0",
      description: "App Store Connect",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });
    for (const s of ["keep", "drop"]) {
      mkdirSync(join(dir, "skills", s), { recursive: true });
      writeFileSync(join(dir, "skills", s, "SKILL.md"), `# ${s}`);
    }

    // Narrowed selection: mcp off, only skill "keep" selected.
    ensureAntigravityRoot(dir, { components: ["skills"], skills: ["keep"] });

    assert.equal(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).mcpServers, undefined);
    // In-place model: dir-level pruning is NOT honored — both skills remain on disk.
    assert.ok(existsSync(join(dir, "skills", "keep", "SKILL.md")));
    assert.ok(existsSync(join(dir, "skills", "drop", "SKILL.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("antigravityGlobalPluginsDir resolves <GEMINI_HOME>/config/plugins, defaulting to ~/.gemini", () => {
  assert.equal(antigravityGlobalPluginsDir({ GEMINI_HOME: "/tmp/g" } as NodeJS.ProcessEnv), join("/tmp/g", "config", "plugins"));
  assert.equal(antigravityGlobalPluginsDir({} as NodeJS.ProcessEnv), join(homedir(), ".gemini", "config", "plugins"));
});

test("detect keys off an antigravity* marker under the Gemini home, not bare ~/.gemini", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adg-agy-home-"));
  try {
    const gemini = join(tmp, "gemini");
    mkdirSync(gemini);
    // A bare Gemini home (plain Gemini CLI) must NOT register Antigravity.
    assert.equal(antigravityAgent.detect({ GEMINI_HOME: gemini } as NodeJS.ProcessEnv), false);
    mkdirSync(join(gemini, "antigravity-cli"));
    assert.equal(antigravityAgent.detect({ GEMINI_HOME: gemini } as NodeJS.ProcessEnv), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("activate (project) writes the manifest in place; listInstalled scopes to the project store", () => {
  const store = mkdtempSync(join(tmpdir(), "adg-agy-proj-"));
  try {
    const dir = seedStore(store, "xcode", {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "xcode",
      version: "1.0.0",
      description: "Xcode",
      skills: "./skills/",
    });
    mkdirSync(join(dir, "skills", "build"), { recursive: true });
    writeFileSync(join(dir, "skills", "build", "SKILL.md"), "# build");

    withGemini(() => {
      const res = antigravityAgent.activate({ pluginsDir: store, plugins: ["xcode"], scope: "project" });
      assert.equal(res.skipped, false);
      assert.deepEqual(res.affected, ["xcode"]);
      // In place: the agy manifest sits at the store folder root, no extra dir.
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")), { name: "xcode" });

      assert.deepEqual(antigravityAgent.listInstalled!({ pluginsDir: store, plugins: [], scope: "project" }), ["xcode"]);
    });
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("activate (user) exposes into the global scan dir; a project query never surfaces it (no leak)", () => {
  const globalStore = mkdtempSync(join(tmpdir(), "adg-agy-global-"));
  const projectStore = mkdtempSync(join(tmpdir(), "adg-agy-empty-proj-"));
  try {
    const gdir = seedStore(globalStore, "asc", {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "asc",
      version: "1.0.0",
      description: "ASC",
      skills: "./skills/",
    });
    mkdirSync(join(gdir, "skills", "s"), { recursive: true });
    writeFileSync(join(gdir, "skills", "s", "SKILL.md"), "# s");
    // Mirror the real bug: a project store whose lock exists but manages nothing.
    writeLock(lockPath(projectStore), { version: 2, plugins: {} });

    withGemini((gemini) => {
      antigravityAgent.activate({ pluginsDir: globalStore, plugins: ["asc"], scope: "user" });

      // Exposed under the official global scan dir, linking back to the store folder.
      const exposed = join(gemini, "config", "plugins", "asc");
      assert.equal(realpathSync(exposed), realpathSync(gdir));
      assert.ok(existsSync(join(exposed, "plugin.json")));

      // Global query sees it; the empty project query does NOT (provenance fixed).
      assert.deepEqual(antigravityAgent.listInstalled!({ pluginsDir: globalStore, plugins: [], scope: "user" }), ["asc"]);
      assert.deepEqual(antigravityAgent.listInstalled!({ pluginsDir: projectStore, plugins: [], scope: "project" }), []);
    });
  } finally {
    rmSync(globalStore, { recursive: true, force: true });
    rmSync(projectStore, { recursive: true, force: true });
  }
});

test("activate refuses to overwrite a non-ADG real directory in the global scan dir", () => {
  const globalStore = mkdtempSync(join(tmpdir(), "adg-agy-guard-"));
  try {
    seedStore(globalStore, "asc", {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "asc",
      version: "1.0.0",
      description: "ASC",
      skills: "./skills/",
    });

    withGemini((gemini) => {
      // A user-owned plugin already sits at the global scan slot, with no agy manifest.
      const slot = join(gemini, "config", "plugins", "asc");
      mkdirSync(slot, { recursive: true });
      writeFileSync(join(slot, "user-data.txt"), "do not delete");

      const res = antigravityAgent.activate({ pluginsDir: globalStore, plugins: ["asc"], scope: "user" });

      // The foreign dir is left intact and the plugin is not reported as enabled.
      assert.ok(existsSync(join(slot, "user-data.txt")));
      assert.deepEqual(res.affected, []);
    });
  } finally {
    rmSync(globalStore, { recursive: true, force: true });
  }
});

test("deactivate removes the projection so the plugin is no longer discovered", () => {
  const store = mkdtempSync(join(tmpdir(), "adg-agy-deact-"));
  try {
    seedStore(store, "demo", {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "demo",
      version: "1.0.0",
      description: "Demo",
      skills: "./skills/",
    });
    withGemini(() => {
      antigravityAgent.activate({ pluginsDir: store, plugins: ["demo"], scope: "project" });
      assert.deepEqual(antigravityAgent.listInstalled!({ pluginsDir: store, plugins: [], scope: "project" }), ["demo"]);

      antigravityAgent.deactivate({ pluginsDir: store, plugins: ["demo"], scope: "project" });
      assert.ok(!existsSync(join(store, "demo", "plugin.json")));
      assert.deepEqual(antigravityAgent.listInstalled!({ pluginsDir: store, plugins: [], scope: "project" }), []);
    });
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("activate and listInstalled are no-ops when Antigravity is absent", () => {
  const store = mkdtempSync(join(tmpdir(), "adg-agy-absent-"));
  const prev = process.env.GEMINI_HOME;
  try {
    const dir = seedStore(store, "demo", {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "demo",
      version: "1.0.0",
      description: "Demo",
      skills: "./skills/",
    });
    // Point GEMINI_HOME at a non-existent dir so detect() is false.
    process.env.GEMINI_HOME = join(store, "no-gemini-here");

    const res = antigravityAgent.activate({ pluginsDir: store, plugins: ["demo"], scope: "project" });
    assert.equal(res.skipped, true);
    assert.ok(!existsSync(join(dir, "plugin.json")));
    assert.equal(antigravityAgent.listInstalled!({ pluginsDir: store, plugins: [], scope: "project" }), undefined);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
    rmSync(store, { recursive: true, force: true });
  }
});
