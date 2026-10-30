import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initPlugin } from "../src/commands/init.ts";
import { addPlugins, installPlugin } from "../src/commands/install.ts";
import { readLock } from "../src/lock.ts";
import { lockPath, pluginSourceCacheDir } from "../src/paths.ts";
import { tmp } from "./helpers.ts";

function fixture() {
  const root = tmp();
  const { pluginDir: source } = initPlugin({ name: "demo", dir: join(root, "src") });
  for (const skill of ["one", "two"]) {
    mkdirSync(join(source, "skills", skill), { recursive: true });
    writeFileSync(join(source, "skills", skill, "SKILL.md"), "Original instructions");
  }
  return { root, source, pluginsDir: join(root, "store") };
}

test("version-only updates preserve publisher version and request runtime sync", () => {
  const f = fixture();
  try {
    installPlugin(f);
    const path = join(f.source, ".agents", ".plugin.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = "2.0.0";
    writeFileSync(path, JSON.stringify(manifest));
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.deepEqual(result.changes, { version: true, content: false, selection: false, source: false });
    assert.equal(result.runtimeRefreshRequired, true);
    assert.equal(result.version, "2.0.0");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("unselected skill updates change source but do not refresh effective installation", () => {
  const f = fixture();
  try {
    installPlugin({ ...f, selection: { components: ["skills"], skills: ["one"] } });
    writeFileSync(join(f.source, "skills", "two", "SKILL.md"), "Updated instructions");
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.equal(result.changes?.content, true);
    assert.equal(result.changed, true);
    assert.equal(result.runtimeRefreshRequired, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("verified identical bytes advance source revision without installation timestamp churn", () => {
  const f = fixture();
  try {
    installPlugin({ ...f, resolvedRevision: "r1", now: "2026-01-01T00:00:00Z" });
    const result = installPlugin({ ...f, resolvedRevision: "r2", skipUnchanged: true, now: "2026-02-01T00:00:00Z" });
    const entry = readLock(lockPath(f.pluginsDir)).plugins.demo!;
    assert.equal(entry.resolvedRevision, "r2");
    assert.equal(entry.updatedAt, "2026-01-01T00:00:00Z");
    assert.equal(result.changed, false);
    assert.equal(result.changes?.source, true);
    assert.equal(result.runtimeRefreshRequired, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("same-version manifest configuration changes remain content updates", () => {
  const f = fixture();
  try {
    installPlugin(f);
    const path = join(f.source, ".agents", ".plugin.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.description = "Updated configuration";
    writeFileSync(path, JSON.stringify(manifest));
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.equal(result.changes?.version, false);
    assert.equal(result.changes?.content, true);
    assert.equal(result.runtimeRefreshRequired, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("selection changes cannot pass the unchanged fast path", () => {
  const f = fixture();
  try {
    installPlugin({ ...f, selection: { components: ["skills"], skills: ["one"] } });
    const result = installPlugin({ ...f, skipUnchanged: true, selection: { components: ["skills"], skills: ["two"] } });
    assert.equal(result.changes?.selection, true);
    assert.equal(result.runtimeRefreshRequired, true);
    assert.equal(readFileSync(join(result.installedTo, "skills", "two", "SKILL.md"), "utf8"), "Original instructions");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("damaged selected payload requests runtime repair even when source is unchanged", () => {
  const f = fixture();
  try {
    const before = installPlugin(f);
    writeFileSync(join(before.installedTo, "skills", "one", "SKILL.md"), "Damaged instructions");
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.equal(result.runtimeRefreshRequired, true);
    assert.equal(readFileSync(join(result.installedTo, "skills", "one", "SKILL.md"), "utf8"), "Original instructions");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an explicit current skill set persists policy and excludes future additions", () => {
  const f = fixture();
  try {
    installPlugin(f);
    installPlugin({ ...f, skipUnchanged: true, selection: { components: ["skills"], skills: ["one", "two"] } });
    assert.deepEqual(readLock(lockPath(f.pluginsDir)).plugins.demo!.selection?.skills, ["one", "two"]);
    mkdirSync(join(f.source, "skills", "three"));
    writeFileSync(join(f.source, "skills", "three", "SKILL.md"), "Future instructions");
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.throws(() => readFileSync(join(result.installedTo, "skills", "three", "SKILL.md")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("damaged auxiliary Antigravity MCP projection requests runtime repair", () => {
  const f = fixture();
  try {
    const manifestPath = join(f.source, ".agents", ".plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.mcpServers = "./.mcp.json";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(f.source, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "example" } } }));
    const before = installPlugin(f);
    const auxiliary = join(before.installedTo, "mcp_config.json");
    const expected = readFileSync(auxiliary, "utf8");
    writeFileSync(auxiliary, "{}");
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.equal(result.runtimeRefreshRequired, true);
    assert.equal(readFileSync(auxiliary, "utf8"), expected);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("missing comparison cache conservatively avoids a version-only claim", () => {
  const f = fixture();
  try {
    installPlugin(f);
    rmSync(pluginSourceCacheDir(f.pluginsDir, "demo"), { recursive: true });
    const path = join(f.source, ".agents", ".plugin.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = "2.0.0";
    writeFileSync(path, JSON.stringify(manifest));
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.equal(result.changes?.content, true);
    assert.equal(result.runtimeRefreshRequired, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("dependency metadata remains a content change and is persisted", () => {
  const f = fixture();
  try {
    installPlugin(f);
    const path = join(f.source, ".agents", ".plugin.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.dependencies = [{ name: "base", version: "^2.0.0" }];
    writeFileSync(path, JSON.stringify(manifest));
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.equal(result.changes?.content, true);
    assert.equal(result.runtimeRefreshRequired, true);
    assert.deepEqual(readLock(lockPath(f.pluginsDir)).plugins.demo!.dependencies, { base: "^2.0.0" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native manifest releases use normalized metadata for version-only classification", async () => {
  const root = tmp();
  try {
    const source = join(root, "native");
    mkdirSync(join(source, ".claude-plugin"), { recursive: true });
    const path = join(source, ".claude-plugin", "plugin.json");
    writeFileSync(path, JSON.stringify({ name: "native", version: "1.0.0", description: "Native plugin" }));
    const pluginsDir = join(root, "store");
    const gitRunner = (args: string[]) => cpSync(source, args.at(-1)!, { recursive: true });
    await addPlugins({ spec: "acme/native", pluginsDir, targets: ["codex"], gitRunner });
    writeFileSync(path, JSON.stringify({ name: "native", version: "2.0.0", description: "Native plugin" }));
    const result = await addPlugins({ spec: "acme/native", pluginsDir, targets: ["codex"], skipUnchanged: true, gitRunner });
    assert.equal(result.installed[0]!.changes?.version, true);
    assert.equal(result.installed[0]!.changes?.content, false);
    assert.equal(result.installed[0]!.runtimeRefreshRequired, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("translated hooks refer to the installed root and unchanged updates do not refresh", () => {
  const f = fixture();
  try {
    const path = join(f.source, ".agents", ".plugin.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.hooks = "./hooks/";
    writeFileSync(path, JSON.stringify(manifest));
    mkdirSync(join(f.source, "hooks"));
    writeFileSync(join(f.source, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo ready" }] }] } }));
    const before = installPlugin(f);
    const hooks = readFileSync(join(before.installedTo, "hooks.json"), "utf8");
    assert.equal(hooks.includes(before.installedTo), true);
    assert.equal(hooks.includes("adg-staging"), false);
    const result = installPlugin({ ...f, skipUnchanged: true });
    assert.equal(result.runtimeRefreshRequired, false);
    assert.equal(result.changed, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
