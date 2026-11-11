import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdg } from "./sandbox-helpers.mjs";

test("normal CLI output stays concise, verbose exposes details and JSON suppresses progress", { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "adg-cli-output-"));
  try {
    const source = join(root, "source");
    const store = join(root, "store");
    mkdirSync(join(source, ".agents"), { recursive: true });
    mkdirSync(join(source, "skills", "demo"), { recursive: true });
    writeFileSync(join(source, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "synthetic", version: "1.0.0", description: "Synthetic CLI output fixture", skills: "./skills" }));
    writeFileSync(join(source, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Synthetic\n---\nInstructions\n");
    const emptyPath = join(root, "empty-path");
    mkdirSync(emptyPath);
    const state = join(root, "state");
    mkdirSync(join(state, "adg"), { recursive: true });
    writeFileSync(join(state, "adg", "update-check.json"), JSON.stringify({ latestVersion: "0.0.0", checkedAt: new Date().toISOString() }));
    const run = (args: string[]) => {
      const { result } = spawnAdg(["plugins", ...args, "--dir", store], {
        isolationRoot: join(root, "agents"), cwd: root, timeout: 10_000,
        env: { PATH: emptyPath, XDG_STATE_HOME: state, ADG_CACHE_HOME: join(root, "cache"), DISABLE_TELEMETRY: "1", NO_COLOR: "1" },
      });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      return result;
    };
    const normal = run(["add", source, "--target", "codex", "--only", "skills"]);
    assert.match(normal.stdout, /added.*synthetic/);
    assert.doesNotMatch(normal.stdout, /sourceHash:|installedHash:|adapted:/);
    const verbose = run(["add", source, "--target", "codex", "--only", "skills", "--verbose"]);
    assert.match(verbose.stdout, /sourceHash:/);
    const added = run(["add", source, "--target", "codex", "--only", "skills", "--json"]);
    assert.equal(JSON.parse(added.stdout).schemaVersion, "adg.plugins.add/v1");
    const progress = run(["update"]);
    assert.match(progress.stderr, /adg plugins update/);
    assert.match(progress.stderr, /rescanning local/);
    const json = run(["update", "--json"]);
    const data = JSON.parse(json.stdout);
    assert.equal(data.schemaVersion, "adg.plugins.update/v1");
    assert.equal(data.scopes.length, 1);
    assert.deepEqual(data.summary, { succeeded: 1, failed: 0 });
    assert.doesNotMatch(json.stderr, /adg plugins update|rescanning|fetching|installing|re-syncing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("JSON update retains deferred candidates independently of explicit exclusions", async () => {
  const { registerHooks } = await import("node:module");
  const marketplaceURL = new URL("../src/commands/marketplace.ts", import.meta.url).href;
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url !== marketplaceURL) return nextLoad(url, context);
      return { format: "module", shortCircuit: true, source: `
        export async function updatePlugins() { return {
          remote: [{source:"example/public", updated:[], unchanged:["installed"], deleted:[], available:[],
            deferredRecovery:["design:unknown"], notRestored:["design:excluded"]}],
          local:{results:[],missing:[]}, agents:[]
        }; }
        export const marketplaceList = () => [];
        export const marketplaceRemove = () => {throw new Error("unexpected mutation")};
        export const marketplaceSync = () => {throw new Error("unexpected mutation")};
      ` };
    },
  });
  let runPlugins: typeof import("../src/cli/handlers.ts").runPlugins;
  try { ({ runPlugins } = await import("../src/cli/handlers.ts")); }
  finally { hooks.deregister(); }
  const root = mkdtempSync(join(tmpdir(), "adg-cli-deferred-json-"));
  const original = console.log;
  const lines: string[] = [];
  console.log = (...items) => { lines.push(items.join(" ")); };
  try {
    const outcome = await runPlugins("update", ["--json", "--dir", root]);
    assert.equal(outcome.exitCode, 0);
    assert.equal(lines.length, 1);
    const data = JSON.parse(lines[0]!);
    assert.deepEqual(data.scopes[0].result.remote[0].deferredRecovery, ["design:unknown"]);
    assert.deepEqual(data.scopes[0].result.remote[0].notRestored, ["design:excluded"]);
    assert.deepEqual(data.summary, { succeeded: 1, failed: 0 });
  } finally { console.log = original; rmSync(root, { recursive: true, force: true }); }
});
