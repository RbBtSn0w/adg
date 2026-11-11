import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { UpdateCancelled } from "../src/commands/review-executables.ts";
import type { PluginUpdateResult } from "../src/commands/marketplace.ts";

// Replace only the external-work boundary; exercise real scope orchestration,
// rendering, cancellation, JSON serialization and command outcome handling.
const callbackKey = Symbol.for("adg.cli-update-test");
const globals = globalThis as typeof globalThis & { [callbackKey]?: (options: unknown) => Promise<PluginUpdateResult> };
const marketplaceURL = new URL("../src/commands/marketplace.ts", import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== marketplaceURL) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: `
      export const updatePlugins = options => globalThis[Symbol.for("adg.cli-update-test")](options);
      export const marketplaceList = () => [];
      export const marketplaceRemove = () => { throw new Error("unexpected mutation"); };
      export const marketplaceSync = () => { throw new Error("unexpected mutation"); };
    ` };
  },
});
const { runPlugins } = await import("../src/cli/handlers.ts");
hooks.deregister();

const partial: PluginUpdateResult = { remote: [{ source: "example/completed", updated: ["done"], unchanged: [], deleted: [], available: [] }], local: { results: [], missing: [] }, agents: [] };
async function capture(args: string[], update: (options: unknown) => Promise<PluginUpdateResult>, verb: "update" | "marketplace" = "update") {
  const log = console.log;
  const error = console.error;
  const write = process.stderr.write;
  const lines: string[] = [];
  const errors: string[] = [];
  globals[callbackKey] = update;
  console.log = (...items) => { lines.push(items.join(" ")); };
  console.error = (...items) => { errors.push(items.join(" ")); };
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return { outcome: await runPlugins(verb, args), output: lines.join("\n"), errors: errors.join("\n") }; }
  finally { console.log = log; console.error = error; process.stderr.write = write; delete globals[callbackKey]; }
}

test("action-required --all retry preserves one-shot inclusion and scope", async () => {
  const run = await capture(["example/public", "--global", "--all"], async () => ({ ...partial, remote: [{ source: "example/public", updated: [], unchanged: [], deleted: [], available: [], actionRequired: ["Review history: design:a"] }] }));
  assert.equal(run.outcome.exitCode, 1);
  assert.match(run.output, /adg plugins update[^`]*--global[^`]*--all/);
});

test("targeted marketplace upgrade retry preserves its target and authorization flags", async () => {
  const run = await capture(["upgrade", "example/public", "--global", "--target", "codex", "--all", "--repair"], async options => {
    const actual = options as { targets: string[]; all: boolean; repair: boolean; agentScope: string; source: string };
    assert.deepEqual(actual.targets, ["codex"]);
    assert.equal(actual.all, true);
    assert.equal(actual.repair, true);
    assert.equal(actual.agentScope, "user");
    assert.equal(actual.source, "example/public");
    return { ...partial, remote: [{ source: "example/public", updated: [], unchanged: [], deleted: [], available: [], actionRequired: ["Review ownership:old:demo: current:demo"] }] };
  }, "marketplace");
  assert.equal(run.outcome.exitCode, 1);
  const output = stripVTControlCharacters(run.output);
  assert.match(output, /adg plugins marketplace upgrade 'example\/public' --global --all --repair --target 'codex'/);
  assert.doesNotMatch(output, /Run `adg plugins update/);
});

test("cancelled scope emits its completed sources and accurate JSON counts", async () => {
  const run = await capture(["--global", "--json"], async () => {
    const error = new UpdateCancelled() as UpdateCancelled & { partial?: PluginUpdateResult };
    error.partial = partial;
    throw error;
  });
  const json = JSON.parse(run.output);
  assert.equal(run.outcome.exitCode, 130);
  assert.equal(json.cancelled, true);
  assert.equal(json.scopes[0]?.result.remote[0]?.source, "example/completed");
  assert.deepEqual(json.summary, { succeeded: 1, failed: 0 });
});

test("human cancellation report preserves completed source work without claiming rollback", async () => {
  const run = await capture(["--global"], async () => {
    const error = new UpdateCancelled() as UpdateCancelled & { partial?: PluginUpdateResult };
    error.partial = partial;
    throw error;
  });
  assert.equal(run.outcome.exitCode, 130);
  const output = stripVTControlCharacters(run.output);
  assert.match(output, /example\/completed: updated 1 plugin/);
  assert.match(output, /1 ok/);
  assert.doesNotMatch(run.errors, /current installation is preserved|no.*changes.*made/i);
  assert.match(run.errors, /completed.*kept|completed.*retained/i);
});

test("cancellation preserves earlier scopes plus completed sources in the current scope", async () => {
  let calls = 0;
  const run = await capture(["--global", "--project", "--json"], async () => {
    if (calls++ === 0) return partial;
    const error = new UpdateCancelled() as UpdateCancelled & { partial?: PluginUpdateResult };
    error.partial = { ...partial, remote: [{ ...partial.remote[0]!, source: "example/second" }] };
    throw error;
  });
  const json = JSON.parse(run.output);
  assert.equal(json.scopes.length, 2);
  assert.equal(json.scopes[1].result.remote[0].source, "example/second");
  assert.deepEqual(json.summary, { succeeded: 2, failed: 0 });
  assert.equal(run.outcome.exitCode, 130);
});
