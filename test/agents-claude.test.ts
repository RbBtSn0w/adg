import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunResult } from "../src/agents/base.ts";
import { parseClaudeMarketplaceDirectories, pruneStaleClaudeMarketplaces, syncMarketplace } from "../src/agents/claude.ts";

function result(ok: boolean, out = ""): RunResult {
  return { ok, out };
}

test("syncMarketplace falls back to add when marketplace update fails", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(false, "update failed");
    if (args[2] === "add") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "update", "adg"],
    ["plugin", "marketplace", "add", "/tmp/plugins"],
  ]);
});

test("syncMarketplace only adds when the marketplace is not listed", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "other" }]));
    if (args[2] === "add") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", "/tmp/plugins"],
  ]);
});

test("syncMarketplace does not add when the marketplace update succeeds", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "update", "adg"],
  ]);
});

test("syncMarketplace warns when the add fallback also fails", () => {
  const warnings: string[] = [];
  const runner = (args: string[]): RunResult => {
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(false, "update failed");
    if (args[2] === "add") return result(false, "add failed");
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /failed to sync Claude marketplace/i);
  assert.match(warnings[0]!, /add failed/);
});

test("parseClaudeMarketplaceDirectories keeps only directory-backed entries with a path", () => {
  const out = JSON.stringify([
    { name: "adg", source: "directory", path: "/global/plugins" },
    { name: "claude-plugins-official", source: "github" }, // no local path — never stale this way
    { name: "adg-deadbeef", source: "directory" }, // malformed: no path
    "not an object",
  ]);
  assert.deepEqual(parseClaudeMarketplaceDirectories(out), [{ name: "adg", path: "/global/plugins" }]);
});

test("parseClaudeMarketplaceDirectories returns [] on unparsable JSON", () => {
  assert.deepEqual(parseClaudeMarketplaceDirectories("not json"), []);
});

test("pruneStaleClaudeMarketplaces removes only ADG-owned marketplaces whose directory is gone", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") {
      return result(
        true,
        JSON.stringify([
          { name: "adg-deadbeef", source: "directory", path: "/tmp/gone" },
          { name: "adg-11111111", source: "directory", path: "/tmp/still-here" },
          { name: "my-own-marketplace", source: "directory", path: "/tmp/also-gone" }, // not ADG-owned — never touched
        ]),
      );
    }
    if (args[2] === "remove" && args[3] === "adg-deadbeef") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };
  const exists = (path: string): boolean => path === "/tmp/still-here";

  const outcome = pruneStaleClaudeMarketplaces(runner, exists);

  assert.deepEqual(outcome, {
    agent: "claude",
    skipped: false,
    removed: [{ name: "adg-deadbeef", path: "/tmp/gone" }],
    errors: [],
  });
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "remove", "adg-deadbeef"],
  ]);
});

test("pruneStaleClaudeMarketplaces reports a removal failure instead of throwing", () => {
  const runner = (args: string[]): RunResult => {
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg-deadbeef", source: "directory", path: "/tmp/gone" }]));
    if (args[2] === "remove") return result(false, "permission denied");
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  const outcome = pruneStaleClaudeMarketplaces(runner, () => false);

  assert.deepEqual(outcome.removed, []);
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0]!, /adg-deadbeef/);
  assert.match(outcome.errors[0]!, /permission denied/);
});

test("pruneStaleClaudeMarketplaces surfaces a list failure without attempting any removal", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    return result(false, "claude: not logged in");
  };

  const outcome = pruneStaleClaudeMarketplaces(runner, () => false);

  assert.deepEqual(outcome, { agent: "claude", skipped: false, removed: [], errors: ["claude: not logged in"] });
  assert.deepEqual(calls, [["plugin", "marketplace", "list", "--json"]]);
});
