import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { codexAgent, codexMarketplaceName, parseCodexInspection, parseCodexPluginListJson } from "../src/agents/codex.ts";
import { makeCli } from "../src/agents/base.ts";
import { pluginStatus } from "../src/commands/status.ts";
import { installPlugin } from "../src/commands/install.ts";
import { tmp, scaffoldSource } from "./helpers.ts";

const record = (name: string, installed: boolean, enabled: boolean, version?: string | null, marketplace = "adg") => ({
  name, pluginId: `${name}@${marketplace}`, marketplaceName: marketplace, installed, enabled,
  ...(version !== undefined ? { version } : {}),
});

test("Codex snapshots preserve registration versions and separate installed, disabled and available plugins", () => {
  const out = JSON.stringify({
    installed: [record("live", true, true, "1.32.2"), record("muted", true, false, "1.32.0"), record("foreign", true, true, "9.0.0", "other")],
    available: [record("optional", false, false, "1.32.2"), record("unknown", false, false, null)],
  });
  assert.deepEqual(parseCodexInspection(out, "adg"), [
    { id: "live@adg", name: "live", installed: true, enabled: true, version: "1.32.2" },
    { id: "muted@adg", name: "muted", installed: true, enabled: false, version: "1.32.0" },
    { id: "optional@adg", name: "optional", installed: false, enabled: false, version: "1.32.2" },
    { id: "unknown@adg", name: "unknown", installed: false, enabled: false },
  ]);
  assert.deepEqual(parseCodexPluginListJson(out, "adg"), ["live"]);
});

test("installed-only snapshots retain compatibility without inventing versions", () => {
  const out = JSON.stringify({ installed: [record("legacy", true, false)] });
  assert.deepEqual(parseCodexInspection(out, "adg"), [{ id: "legacy@adg", name: "legacy", installed: true, enabled: false }]);
});

test("malformed Codex state is unknown rather than an empty successful query", () => {
  for (const invalid of [
    record("bad", false, true, "1.0.0"),
    { ...record("bad", true, false), enabled: "false" },
    { ...record("bad", true, false), version: 42 },
    { ...record("bad", true, false), pluginId: "bad@other" },
  ]) {
    const out = JSON.stringify({ installed: [invalid], available: [] });
    assert.equal(parseCodexInspection(out, "adg"), undefined);
    assert.equal(parseCodexPluginListJson(out, "adg"), undefined);
  }
  for (const out of ["{}", "not json", '{"installed":[],"available":{}}']) {
    assert.equal(parseCodexInspection(out, "adg"), undefined);
  }
  assert.deepEqual(parseCodexInspection('{"installed":[],"available":[]}', "adg"), []);
});

test("Codex snapshots reject installation flags that contradict their containing array", () => {
  for (const snapshot of [
    { installed: [record("bad", false, false)] },
    { installed: [record("bad", false, false)], available: [] },
    { installed: [], available: [record("bad", true, false)] },
    { installed: [], available: [record("bad", true, true)] },
  ]) {
    const out = JSON.stringify(snapshot);
    assert.equal(parseCodexInspection(out, "adg"), undefined);
    assert.equal(parseCodexPluginListJson(out, "adg"), undefined);
  }
});

test("CLI capture preserves JSON stdout independently from stderr diagnostics", () => {
  const cli = makeCli("node", { probeArgs: [] });
  const result = cli.run(["-e", 'process.stdout.write("{}");process.stderr.write("warning")']);
  assert.equal(result.ok, true);
  assert.deepEqual(result, { ok: true, out: "{}warning", stdout: "{}", stderr: "warning" });
});

test("Codex status parses stdout despite warnings and never runs mutating commands", (t) => {
  const root = tmp();
  const previous = process.env.ADG_CACHE_HOME;
  process.env.ADG_CACHE_HOME = join(root, "cache");
  try {
    const { dir } = scaffoldSource(root);
    const pluginsDir = join(root, "store");
    installPlugin({ source: dir, pluginsDir });
    const marketplace = codexMarketplaceName(pluginsDir);
    const snapshot = JSON.stringify({ installed: [record("pkgdemo", true, false, "1.32.0", marketplace)], available: [record("optional", false, false, "1.32.2", marketplace)] });
    const calls: string[][] = [];
    let exitStatus = 0;
    const spawn = t.mock.method(childProcess, "spawnSync", (_bin: string, args: string[]) => {
      calls.push(args);
      assert.ok(args.includes("--help") || (args[0] === "plugin" && args[1] === "list"), "only read-only CLI calls are permitted");
      return { pid: 42, status: exitStatus, signal: null, stdout: args.includes("--help") ? "" : snapshot, stderr: "WARNING: could not create PATH aliases\n" };
    });
    syncBuiltinESMExports();
    try {
      const ctx = { pluginsDir, plugins: [], scope: "user" as const };
      const [status] = pluginStatus({ pluginsDir, scope: "user", agents: [codexAgent] });
      assert.equal(status!.queryable, true);
      assert.deepEqual(status!.inSync, []);
      assert.deepEqual(status!.runtimeMissing, []);
      assert.deepEqual(status!.runtimeDisabled, ["pkgdemo"]);
      assert.deepEqual(status!.runtimePlugins, [
        { id: `pkgdemo@${marketplace}`, name: "pkgdemo", version: "1.32.0", installed: true, enabled: false },
        { id: `optional@${marketplace}`, name: "optional", version: "1.32.2", installed: false, enabled: false },
      ]);
      assert.deepEqual(codexAgent.listInstalled!(ctx), []);
      assert.ok(calls.length >= 2);
      exitStatus = 1;
      const [failed] = pluginStatus({ pluginsDir, scope: "user", agents: [codexAgent] });
      assert.equal(failed!.queryable, false);
      assert.match(failed!.queryError!, /could not create PATH aliases/);
      assert.equal(failed!.runtimePlugins, undefined);
    } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
  } finally {
    if (previous === undefined) delete process.env.ADG_CACHE_HOME; else process.env.ADG_CACHE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
