import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ADAPTER_TARGETS } from "../src/adapters/index.ts";
import {
  MARKETPLACE_USAGE,
  PLUGIN_COMMANDS,
  parseVerb,
  renderPluginsHelp,
  renderVerbHelp,
  requireSingleTarget,
  resolveComponents,
  resolveScopeDir,
  resolveTargets,
  scopeOf,
} from "../src/cli/index.ts";
import { projectStoreIsGlobalTrap, promoteGlobalTrap, runPlugins } from "../src/cli/handlers.ts";

// `fail()` (reached by every invalid-input path) calls `process.exit(1)`, which
// would kill the test runner. Stub it to throw so the exit path is assertable,
// and silence the usage text it prints to stderr.
function expectFail(fn: () => unknown): void {
  const origExit = process.exit;
  const origErr = console.error;
  let exited = false;
  process.exit = ((code?: number) => {
    exited = true;
    throw new Error(`process.exit(${code})`);
  }) as never;
  console.error = () => {};
  try {
    fn();
    assert.fail("expected the call to exit");
  } catch (err) {
    assert.equal(exited, true, `expected process.exit, got: ${String(err)}`);
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
}

// Async twin of expectFail: a mutating verb resolves its scope asynchronously,
// so the non-interactive "needs an explicit scope" guard exits from a promise.
async function expectFailAsync(fn: () => Promise<unknown>): Promise<void> {
  const origExit = process.exit;
  const origErr = console.error;
  let exited = false;
  process.exit = ((code?: number) => {
    exited = true;
    throw new Error(`process.exit(${code})`);
  }) as never;
  console.error = () => {};
  try {
    await fn();
    assert.fail("expected the call to exit");
  } catch (err) {
    assert.equal(exited, true, `expected process.exit, got: ${String(err)}`);
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
}

test("projectStoreIsGlobalTrap flags only a project scope whose store is the global store", () => {
  // The home==global trap: project scope, but the resolved dirs coincide.
  assert.equal(projectStoreIsGlobalTrap(false, "/h/.agents/plugins", "/h/.agents/plugins"), true);
  // Explicit global is never the trap.
  assert.equal(projectStoreIsGlobalTrap(true, "/h/.agents/plugins", "/h/.agents/plugins"), false);
  // A genuine project store distinct from global is fine.
  assert.equal(projectStoreIsGlobalTrap(false, "/repo/.agents/plugins", "/h/.agents/plugins"), false);
});

test("promoteGlobalTrap promotes a project scope whose store is the global store", () => {
  // Pass the store dirs explicitly so the test is independent of cwd/env: a
  // project store equal to the global store is the home==global trap.
  const origErr = console.error;
  let warned = false;
  console.error = () => {
    warned = true;
  };
  try {
    assert.equal(promoteGlobalTrap(false, "/h/.agents/plugins", "/h/.agents/plugins"), true);
    assert.equal(warned, true, "expected a promotion warning");
    warned = false;
    // Already global, or a distinct project store: no promotion, no warning.
    assert.equal(promoteGlobalTrap(true, "/h/.agents/plugins", "/h/.agents/plugins"), true);
    assert.equal(promoteGlobalTrap(false, "/repo/.agents/plugins", "/h/.agents/plugins"), false);
    assert.equal(warned, false, "did not expect a warning when there is no trap");
  } finally {
    console.error = origErr;
  }
});

test("a mutating verb without a scope flag fails in a non-interactive run", async () => {
  const stdin = process.stdin as { isTTY?: boolean };
  const orig = stdin.isTTY;
  stdin.isTTY = false;
  try {
    await expectFailAsync(() => runPlugins("sync", ["--target", "claude"]));
  } finally {
    stdin.isTTY = orig;
  }
});

test("a mutating verb rejects contradictory --global and --project", async () => {
  await expectFailAsync(() => runPlugins("sync", ["--target", "claude", "--global", "--project"]));
});

test("resolveTargets maps friendly aliases to canonical ids", () => {
  assert.deepEqual(resolveTargets("agy"), ["antigravity"]);
  assert.deepEqual(resolveTargets("gemini"), ["antigravity"]);
  assert.deepEqual(resolveTargets("openai"), ["codex"]);
  assert.deepEqual(resolveTargets("anthropic"), ["claude"]);
});

test("resolveTargets returns every target for undefined / all", () => {
  assert.deepEqual(resolveTargets(undefined), [...ADAPTER_TARGETS]);
  assert.deepEqual(resolveTargets("all"), [...ADAPTER_TARGETS]);
});

test("resolveTargets exits on an unknown target", () => {
  expectFail(() => resolveTargets("nope"));
});

test("requireSingleTarget rejects a missing or 'all' target", () => {
  expectFail(() => requireSingleTarget(undefined, "link"));
  expectFail(() => requireSingleTarget("all", "sync"));
});

test("requireSingleTarget returns the one resolved target", () => {
  assert.equal(requireSingleTarget("agy", "link"), "antigravity");
  assert.equal(requireSingleTarget("claude", "sync"), "claude");
});

test("resolveComponents parses, trims, and validates a --only list", () => {
  assert.equal(resolveComponents(undefined), undefined);
  assert.deepEqual(resolveComponents("skills, commands"), ["skills", "commands"]);
});

test("resolveComponents exits on an unknown component type", () => {
  expectFail(() => resolveComponents("skills,bogus"));
});

test("scopeOf maps --global to user, else project", () => {
  assert.equal(scopeOf({ global: true }), "user");
  assert.equal(scopeOf({}), "project");
});

test("resolveScopeDir prefers an explicit --dir", () => {
  assert.equal(resolveScopeDir({ dir: "some/dir" }), resolve("some/dir"));
});

test("parseVerb splits declared flags from positionals", () => {
  const { values, positionals } = parseVerb("add", PLUGIN_COMMANDS.add!.flags, [
    "owner/repo",
    "--all",
    "--target",
    "codex",
  ]);
  assert.equal(positionals[0], "owner/repo");
  assert.equal(values.all, true);
  assert.equal(values.target, "codex");
});

test("renderPluginsHelp lists every command and tags the start verb", () => {
  const help = renderPluginsHelp();
  for (const name of Object.keys(PLUGIN_COMMANDS)) assert.ok(help.includes(name), `missing ${name}`);
  assert.match(help, /add .*← start here/);
});

test("renderVerbHelp shows the synopsis, flags, and examples for a verb", () => {
  const help = renderVerbHelp("add");
  assert.match(help, /adg plugins add <source>/);
  assert.match(help, /Flags:/);
  assert.match(help, /Examples:/);
});

// Capture console.log over an async call, restoring it even on throw.
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("runPlugins with no verb prints the L1 overview", async () => {
  const out = await captureLog(() => runPlugins(undefined, []));
  assert.equal(out, renderPluginsHelp());
});

test("runPlugins <verb> -h prints that verb's help", async () => {
  const out = await captureLog(() => runPlugins("add", ["-h"]));
  assert.equal(out, renderVerbHelp("add"));
});

// Regression: a delegated verb (marketplace) with `<sub> -h` must show the
// marketplace usage, not error out in the sub-parser. Also exercises the `mp`
// alias and the delegation handoff.
test("runPlugins marketplace <sub> -h prints the marketplace usage", async () => {
  const viaList = await captureLog(() => runPlugins("marketplace", ["list", "-h"]));
  assert.equal(viaList, MARKETPLACE_USAGE);

  const viaAlias = await captureLog(() => runPlugins("mp", ["-h"]));
  assert.equal(viaAlias, MARKETPLACE_USAGE);
});

// Capture console.error over an async call, restoring it even on throw.
async function captureError(fn: () => Promise<void>): Promise<string> {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines.join("\n");
}

// The deprecated `marketplace upgrade` alias must report a failed re-fetch (here:
// an unknown source) instead of letting `updatePlugins` reject to the top-level
// catch — matching `plugins update`'s per-call error handling.
test("runPlugins marketplace upgrade reports a failed re-fetch without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-cli-upgrade-"));
  try {
    const err = await captureError(() => runPlugins("marketplace", ["upgrade", "nope/repo", "--dir", dir]));
    assert.match(err, /no installed source/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
