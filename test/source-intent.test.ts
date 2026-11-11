import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPlugin } from "../src/commands/init.ts";
import { addPlugins } from "../src/commands/install.ts";
import { updatePlugins } from "../src/commands/marketplace.ts";
import { removePlugin } from "../src/commands/remove.ts";
import { readLock } from "../src/lock.ts";
import { installedPluginDir, lockPath } from "../src/paths.ts";

test("an explicit all-source install follows new plugins while respecting removals", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-source-intent-"));
  try {
    const remote = join(root, "source");
    const pluginsDir = join(root, "store");
    const gitRunner = (args: string[]) => cpSync(remote, args.at(-1)!, { recursive: true });
    initPlugin({ name: "one", dir: remote });
    initPlugin({ name: "two", dir: remote });
    await addPlugins({ spec: "example/toolbox", pluginsDir, gitRunner, all: true, agents: [] });
    removePlugin({ pluginsDir, name: "two" });
    initPlugin({ name: "three", dir: remote });
    await updatePlugins({ pluginsDir, gitRunner, agents: [], revisionResolver: () => "new" });
    assert.deepEqual(Object.keys(readLock(lockPath(pluginsDir)).plugins).sort(), ["one", "three"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keep an undeclared retirement in update without prompting on the next revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-retirement-"));
  try {
    const remote = join(root, "source");
    const pluginsDir = join(root, "store");
    const gitRunner = (args: string[]) => cpSync(remote, args.at(-1)!, { recursive: true });
    const first = initPlugin({ name: "first", dir: remote }).pluginDir;
    initPlugin({ name: "peer", dir: remote });
    await addPlugins({ spec: "example/kit", pluginsDir, gitRunner, plugins: ["first", "peer"], agents: [] });
    rmSync(first, { recursive: true });
    const result = await updatePlugins({
      pluginsDir,
      gitRunner,
      agents: [],
      revisionResolver: () => "two",
      review: async ({ history }) => {
        assert.deepEqual(
          history.map((item) => item.id),
          ["unmapped:first"],
        );
        return { history: { "unmapped:first": { action: "keep" } }, allow: [] };
      },
    });
    assert.deepEqual(result.remote[0]?.retained, ["first"]);
    assert.equal(result.remote[0]?.failed, undefined);
    const repeated = await updatePlugins({
      pluginsDir,
      gitRunner,
      agents: [],
      revisionResolver: () => "three",
      review: async () => {
        throw new Error("review repeated");
      },
    });
    assert.deepEqual(repeated.remote[0]?.retained, ["first"]);
    assert.equal(repeated.remote[0]?.missingUpstream, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("denying one new MCP service persists across source revisions while later services still get reviewed", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-executable-decision-"));
  try {
    const remote = join(root, "source");
    const pluginsDir = join(root, "store");
    const dir = initPlugin({ name: "kit", dir: remote }).pluginDir;
    const manifestPath = join(dir, ".agents/.plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.mcpServers = "./.mcp.json";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const config = (servers: string[]) =>
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: Object.fromEntries(servers.map((name) => [name, { command: name }])),
        }),
      );
    config(["original"]);
    const gitRunner = (args: string[]) => cpSync(remote, args.at(-1)!, { recursive: true });
    const targets = ["codex" as const];
    await addPlugins({ spec: "example/kit", pluginsDir, gitRunner, targets, agents: [] });
    const before = readLock(lockPath(pluginsDir));
    const opts = { pluginsDir, gitRunner, agents: [] };
    config(["original", "optional"]);
    const unattended = await updatePlugins({ ...opts, revisionResolver: () => "two" });
    assert.match(unattended.remote[0]?.actionRequired?.join(" ") ?? "", /optional/);
    assert.deepEqual(readLock(lockPath(pluginsDir)), before);
    const declined = await updatePlugins({
      ...opts,
      revisionResolver: () => "two",
      review: async () => ({ history: {}, allow: [] }),
    });
    assert.deepEqual(declined.remote[0]?.actionRequired, undefined);
    assert.equal(declined.remote[0]?.failed, undefined);
    const effective = () => {
      const lock = readLock(lockPath(pluginsDir));
      const file = join(installedPluginDir(pluginsDir, "kit", lock.plugins.kit!.origin), ".mcp.json");
      return Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers).sort();
    };
    assert.deepEqual(effective(), ["original"]);
    config(["original", "optional", "later"]);
    const prompts: string[] = [];
    const result = await updatePlugins({
      ...opts,
      revisionResolver: () => "three",
      review: async ({ executable }) => {
        prompts.push(...executable.map((item) => item.label));
        return { history: {}, allow: executable.map((item) => item.key) };
      },
    });
    assert.equal(result.remote[0]?.failed, undefined);
    assert.equal(prompts.length, 1, prompts.join(", "));
    assert.match(prompts[0]!, /later/);
    assert.deepEqual(effective(), ["later", "original"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a same-file structural hook addition is reviewed before the stored hook can change", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-structural-review-"));
  try {
    const remote = join(root, "source");
    mkdirSync(join(remote, "hooks"), { recursive: true });
    const config = (commands: string[]) =>
      writeFileSync(
        join(remote, "hooks/hooks.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: commands.map((command) => ({ type: "command", command })) }] },
        }),
      );
    config(["old"]);
    const pluginsDir = join(root, "store");
    const gitRunner = (args: string[]) => cpSync(remote, args.at(-1)!, { recursive: true });
    await addPlugins({
      spec: "example/hooks",
      as: "hooks",
      pluginsDir,
      gitRunner,
      only: ["hooks"],
      targets: ["codex"],
      agents: [],
    });
    config(["old", "new"]);
    const before = readLock(lockPath(pluginsDir));
    const opts = { pluginsDir, gitRunner, agents: [], revisionResolver: () => "abcdef" };
    const result = await updatePlugins(opts);
    assert.match(result.remote[0]?.actionRequired?.join(" ") ?? "", /SessionStart hook/);
    assert.deepEqual(readLock(lockPath(pluginsDir)), before);
    const allowed = await updatePlugins({
      ...opts,
      review: async ({ executable }) => ({ history: {}, allow: executable.map((item) => item.key) }),
    });
    assert.deepEqual(allowed.remote[0]?.updated, ["hooks"]);
    const entry = readLock(lockPath(pluginsDir)).plugins.hooks!;
    assert.equal(entry.definition?.as, "hooks");
    assert.equal(entry.resolvedRevision, "abcdef");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
